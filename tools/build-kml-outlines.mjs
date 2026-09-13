#!/usr/bin/env node
/**
 * tools/build-kml-outlines.mjs
 *
 * Builds the parent-level outlines (country / province / district / municipality) served to the
 * userscript from GitHub Pages.
 *
 * Sources
 *   KML_Province/<PROV>.kml                          one file per province; one <Placemark> per local
 *                                                    unit (774 in total) carrying DISTRICT_3,
 *                                                    GAPA_NAP_2 and GN_TYPE_12
 *   Nepal_Intl_Boundary/Nepal_Intl_Boudnary.geojson  the national outline, a single Polygon
 *
 * The national boundary comes from a different source than the local-unit polygons and sits about
 * 250 m east of them, so it is shifted onto the authoritative border. Measured by nearest-vertex
 * matching against the local-unit border, -250 m east / +25 m north minimises the mean distance
 * (150 m, limited by how differently the two datasets generalise the border).
 *
 * Why these sources: an earlier revision dissolved the WARD layer instead, which produced broken
 * parents (the ward KMLs are a labelling/seam source, not clean topology). The local-unit polygons
 * are authoritative and neighbouring units share bit-identical edges, so dissolving them by edge
 * cancellation is exact — measured 0 unclosed rings and exactly one shell per district and province.
 *
 *   municipality -> the unit's own polygons (dissolved against themselves, to drop the seams of
 *                   units that arrive split over several Placemarks)
 *   district     -> dissolve of its municipalities
 *   province     -> dissolve of its municipalities (equivalent to dissolving its districts)
 *   country      -> the boundary GeoJSON, as-is
 *
 * Output (default <repo>/outlines — 79 files)
 *   country.json             1 feature  (level: country)
 *   province.json            7 features (level: province)
 *   <PROV>-<DISTRICT>.json   that district's outline + every municipality inside it
 *
 * One file per district serves both the district and the municipality level, so the userscript only
 * downloads the handful of districts that are actually in view. Every feature carries a bbox
 * property ([minLon, minLat, maxLon, maxLat]) for client-side viewport tests.
 *
 * Usage:
 *   node tools/build-kml-outlines.mjs
 *   node tools/build-kml-outlines.mjs --simplify=0.0002 --quiet
 *   node tools/build-kml-outlines.mjs --check
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const PROVINCES = {
  KO: { npp: 'NPP1', name: 'Koshi' },
  MA: { npp: 'NPP2', name: 'Madhesh' },
  BA: { npp: 'NPP3', name: 'Bagmati' },
  GA: { npp: 'NPP4', name: 'Gandaki' },
  LU: { npp: 'NPP5', name: 'Lumbini' },
  KA: { npp: 'NPP6', name: 'Karnali' },
  SU: { npp: 'NPP7', name: 'Sudurpashchim' },
};

const SCHEMA = 2;                 // 2 = local-unit based outlines (1 was ward-dissolved)
const SNAP_DECIMALS = 6;          // ~0.11 m grid; guarantees shared borders hash to the same key

// Coarser levels can afford a coarser outline: they are only ever drawn zoomed out. District and
// municipality share a tolerance because they are drawn together — differing tolerances would let a
// district line drift from the municipality lines that make it up.
const SIMPLIFY_FACTOR = { municipality: 1, district: 1, province: 2, country: 4 };

// Edge cancellation is only exact when both units carry the identical border vertex pair. A larger
// relative area difference than this means the source polygons were not topologically clean.
const AREA_TOLERANCE = 0.0005;    // 0.05%

// ─────────────────────────────────────────────── args

function printUsage() {
  console.log(`Usage: node tools/build-kml-outlines.mjs [options]

  --provinces=<dir>   Folder of <PROV>.kml files (default: <repo>/KML_Province)
  --country=<file>    National outline GeoJSON (default: <repo>/Nepal_Intl_Boundary/Nepal_Intl_Boudnary.geojson)
  --country-north=<m> Shift the national outline north by this many metres (default: 25)
  --country-east=<m>  Shift the national outline east by this many metres (default: -250)
  --out=<dir>         Output folder (default: <repo>/outlines)
  --simplify=<deg>    Base Douglas-Peucker tolerance in degrees (default 0.0001, 0 disables)
  --precision=<n>     Decimal places for output coordinates (default 6)
  --check             Do not write; exit 1 if any output is missing or stale
  --quiet             Only print warnings and the final summary
  -h, --help          Show this help`);
}

function parseArgs(argv) {
  const opts = {
    provinces: path.join(REPO_ROOT, 'KML_Province'),
    country: path.join(REPO_ROOT, 'Nepal_Intl_Boundary', 'Nepal_Intl_Boudnary.geojson'),
    countryNorth: 25,   // metres; aligns the national outline with the local-unit border
    countryEast: -250,  // metres
    out: path.join(REPO_ROOT, 'outlines'),
    simplify: 0.0001,
    precision: 6,
    check: false,
    quiet: false,
  };

  for (const arg of argv) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '-h' || arg === '--help') { printUsage(); process.exit(0); }
    else if (arg.startsWith('--provinces=')) opts.provinces = path.resolve(REPO_ROOT, arg.slice(12));
    else if (arg.startsWith('--country=')) opts.country = path.resolve(REPO_ROOT, arg.slice(10));
    else if (arg.startsWith('--country-north=')) opts.countryNorth = Number(arg.slice(16));
    else if (arg.startsWith('--country-east=')) opts.countryEast = Number(arg.slice(15));
    else if (arg.startsWith('--out=')) opts.out = path.resolve(REPO_ROOT, arg.slice(6));
    else if (arg.startsWith('--simplify=')) opts.simplify = Number(arg.slice(11));
    else if (arg.startsWith('--precision=')) opts.precision = Number(arg.slice(12));
    else { console.error(`Unknown option: ${arg}\n`); printUsage(); process.exit(2); }
  }

  if (!Number.isFinite(opts.simplify) || opts.simplify < 0) { console.error('--simplify must be >= 0'); process.exit(2); }
  if (!Number.isFinite(opts.countryNorth) || !Number.isFinite(opts.countryEast)) { console.error('--country-north / --country-east must be numbers'); process.exit(2); }
  if (!Number.isInteger(opts.precision) || opts.precision < 0 || opts.precision > 12) { console.error('--precision must be an integer 0-12'); process.exit(2); }
  return opts;
}

// ─────────────────────────────────────────────── geometry helpers

const snap = (value) => Math.round(value * 10 ** SNAP_DECIMALS) / 10 ** SNAP_DECIMALS;
const vkey = (p) => `${p[0]},${p[1]}`;

/** Shoelace signed area; positive = counter-clockwise. */
function signedArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return area / 2;
}

/** Net area of a polygon set (shells positive, holes negative). */
const netArea = (polygons) =>
  polygons.reduce((sum, rings) => sum + rings.reduce((ringSum, ring) => ringSum + signedArea(ring), 0), 0);

/** Ray casting. */
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Parses a KML <coordinates> payload into a cleaned, closed ring of [lon, lat]. */
function parseRing(coordText) {
  const ring = [];
  for (const tuple of coordText.trim().split(/\s+/)) {
    if (!tuple) continue;
    const comma = tuple.indexOf(',');
    if (comma === -1) continue;
    const lon = Number(tuple.slice(0, comma));
    const lat = Number(tuple.slice(comma + 1).split(',')[0]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    ring.push([snap(lon), snap(lat)]);
  }

  const cleaned = ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
  if (cleaned.length < 3) return null;
  if (cleaned[0][0] !== cleaned[cleaned.length - 1][0] || cleaned[0][1] !== cleaned[cleaned.length - 1][1]) {
    cleaned.push([cleaned[0][0], cleaned[0][1]]);
  }
  return cleaned.length >= 4 ? cleaned : null;
}

/** Normalises rings into [shell, ...holes] with the shell CCW and the holes CW. */
function normaliseRings(rings) {
  if (rings.length === 0) return null;
  // The largest ring is the shell regardless of element order; the rest are holes.
  rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  return rings.map((ring, index) => {
    const isShell = index === 0;
    const ccw = signedArea(ring) > 0;
    return ccw === isShell ? ring : ring.slice().reverse();
  });
}

/**
 * Extracts the local units of one KML_Province file.
 * @returns {{ attrs: Record<string,string>, polygons: number[][][] }[]} one entry per <Placemark>
 */
function parseProvinceKml(text) {
  const units = [];
  const placemarkRe = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let placemarkMatch;

  while ((placemarkMatch = placemarkRe.exec(text)) !== null) {
    const body = placemarkMatch[1];
    const attrs = {};
    for (const [, name, value] of body.matchAll(/<SimpleData\s+name="([^"]+)"\s*>([\s\S]*?)<\/SimpleData>/gi)) {
      attrs[name] = value.trim();
    }

    const polygons = [];
    const polygonRe = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/gi;
    let polygonMatch;

    while ((polygonMatch = polygonRe.exec(body)) !== null) {
      const rings = [];
      const ringRe = /<LinearRing\b[^>]*>([\s\S]*?)<\/LinearRing>/gi;
      let ringMatch;

      while ((ringMatch = ringRe.exec(polygonMatch[1])) !== null) {
        const coords = /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/i.exec(ringMatch[1]);
        if (!coords) continue;
        const ring = parseRing(coords[1]);
        if (ring) rings.push(ring);
      }

      const normalised = normaliseRings(rings);
      if (normalised) polygons.push(normalised);
    }

    units.push({ attrs, polygons });
  }

  return units;
}

/** Extracts polygons from any GeoJSON Feature / FeatureCollection / geometry object. */
function parseGeoJsonPolygons(node, out = []) {
  if (!node) return out;

  if (node.type === 'FeatureCollection') {
    for (const feature of node.features ?? []) parseGeoJsonPolygons(feature, out);
    return out;
  }
  if (node.type === 'Feature') return parseGeoJsonPolygons(node.geometry, out);

  if (node.type === 'Polygon' || node.type === 'MultiPolygon') {
    const raw = node.type === 'Polygon' ? [node.coordinates] : node.coordinates;
    for (const polygon of raw) {
      const rings = [];
      for (const ring of polygon) {
        const parsed = [];
        for (const position of ring) {
          const lon = Number(position[0]);
          const lat = Number(position[1]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          parsed.push([snap(lon), snap(lat)]);
        }
        const cleaned = parsed.filter((p, i) => i === 0 || p[0] !== parsed[i - 1][0] || p[1] !== parsed[i - 1][1]);
        if (cleaned.length >= 3) {
          if (cleaned[0][0] !== cleaned[cleaned.length - 1][0] || cleaned[0][1] !== cleaned[cleaned.length - 1][1]) {
            cleaned.push([cleaned[0][0], cleaned[0][1]]);
          }
          if (cleaned.length >= 4) rings.push(cleaned);
        }
      }
      const normalised = normaliseRings(rings);
      if (normalised) out.push(normalised);
    }
  }

  return out;
}

/**
 * Cancels shared edges between all polygons of a group and chains the remainder into rings.
 * @returns {{ rings: number[][][], cancelled: number, totalEdges: number, open: number }}
 */
function dissolve(polygons) {
  const edgeCount = new Map();
  const points = new Map();
  let totalEdges = 0;

  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const ka = vkey(a);
        const kb = vkey(b);
        if (ka === kb) continue;
        points.set(ka, a);
        points.set(kb, b);
        const key = `${ka}|${kb}`;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        totalEdges++;
      }
    }
  }

  // Cancel opposite-direction pairs (each unordered pair handled once).
  const outgoing = new Map();
  const pushEdge = (from, to, times) => {
    const list = outgoing.get(from) || [];
    for (let i = 0; i < times; i++) list.push({ to, used: false });
    outgoing.set(from, list);
  };

  const pairs = new Set();
  for (const key of edgeCount.keys()) {
    const [a, b] = key.split('|');
    pairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }

  let cancelled = 0;
  for (const pair of pairs) {
    const [a, b] = pair.split('|');
    const ab = edgeCount.get(`${a}|${b}`) || 0;
    const ba = edgeCount.get(`${b}|${a}`) || 0;
    const drop = Math.min(ab, ba);
    cancelled += drop * 2;
    if (ab - drop > 0) pushEdge(a, b, ab - drop);
    if (ba - drop > 0) pushEdge(b, a, ba - drop);
  }

  /** Picks the most clockwise (sharpest right) continuation, keeping the interior on the left. */
  function pickNext(fromKey, toKey, candidates) {
    if (candidates.length === 1) return candidates[0];
    const [ax, ay] = points.get(fromKey);
    const [bx, by] = points.get(toKey);
    const dx = bx - ax;
    const dy = by - ay;
    let best = candidates[0];
    let bestTurn = Infinity;
    for (const candidate of candidates) {
      const [cx, cy] = points.get(candidate.to);
      const ex = cx - bx;
      const ey = cy - by;
      const turn = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
      if (turn < bestTurn) { bestTurn = turn; best = candidate; }
    }
    return best;
  }

  const rings = [];
  let open = 0;

  for (const [startKey, list] of outgoing) {
    for (const startEdge of list) {
      if (startEdge.used) continue;

      const ring = [];
      let prevKey = startKey;
      let edge = startEdge;

      while (edge && !edge.used) {
        edge.used = true;
        ring.push(points.get(prevKey));

        const toKey = edge.to;
        const candidates = (outgoing.get(toKey) || []).filter((candidate) => !candidate.used);
        if (candidates.length === 0) { prevKey = toKey; break; }

        edge = pickNext(prevKey, toKey, candidates);
        prevKey = toKey;
      }

      const last = points.get(prevKey);
      ring.push([last[0], last[1]]);

      const first = ring[0];
      if (first[0] !== last[0] || first[1] !== last[1]) open++;
      if (ring.length >= 4) rings.push(ring);
    }
  }

  return { rings, cancelled, totalEdges, open };
}

/** Groups traced rings into polygons (shells with their holes). */
function ringsToPolygons(rings) {
  const shells = [];
  const holes = [];

  for (const ring of rings) {
    const area = signedArea(ring);
    if (Math.abs(area) < 1e-12) continue;
    if (area > 0) shells.push(ring);
    else holes.push(ring);
  }

  const polygons = shells.map((shell) => [shell]);

  for (const hole of holes) {
    const point = hole[0];
    let bestIndex = -1;
    let bestArea = Infinity;
    for (let i = 0; i < polygons.length; i++) {
      const shell = polygons[i][0];
      if (!pointInRing(point, shell)) continue;
      const area = Math.abs(signedArea(shell));
      if (area < bestArea) { bestArea = area; bestIndex = i; }
    }
    if (bestIndex === -1) polygons.push([hole]); // orphan ring: keep it visible
    else polygons[bestIndex].push(hole);
  }

  return polygons.filter((ringsOfPolygon) => ringsOfPolygon[0].length >= 4);
}

// ─────────────────────────────────────────────── simplification

function perpendicularDistance(point, start, end) {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + clamped * dx), y - (y1 + clamped * dy));
}

function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) { maxDistance = distance; index = i; }
  }
  if (maxDistance <= tolerance) return [points[0], points[points.length - 1]];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function simplifyRing(ring, tolerance) {
  if (tolerance <= 0 || ring.length <= 4) return ring;
  const simplified = douglasPeucker(ring, tolerance);
  if (simplified.length < 4) return ring; // too aggressive — keep the original ring
  const first = simplified[0];
  const last = simplified[simplified.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) simplified.push([first[0], first[1]]);
  return simplified;
}

/**
 * Small islands and riverine slivers would be flattened away by the tolerance used for the main
 * boundary, so scale the tolerance down for short rings (~5% of their own size).
 */
function ringTolerance(ring, base) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return Math.min(base, Math.hypot(maxLon - minLon, maxLat - minLat) * 0.05);
}

/**
 * Shifts a polygon set by a metric offset, converted at its mean latitude.
 * The national boundary GeoJSON is a different source from the local-unit polygons and sits east of
 * them, so this nudges it onto the authoritative border (see the --country-north/--country-east
 * defaults for the measured best fit).
 */
function offsetPolygons(polygons, northMeters, eastMeters) {
  if (northMeters === 0 && eastMeters === 0) return polygons;

  let sumLat = 0;
  let count = 0;
  for (const rings of polygons) for (const ring of rings) for (const [, lat] of ring) { sumLat += lat; count++; }
  const meanLat = count > 0 ? sumLat / count : 27.7;

  const dLat = northMeters / 111320;
  const dLon = eastMeters / (111320 * Math.cos((meanLat * Math.PI) / 180));

  return polygons.map((rings) => rings.map((ring) =>
    ring.map(([lon, lat]) => [snap(lon + dLon), snap(lat + dLat)])));
}

const roundCoord = (value, precision) => Number(value.toFixed(precision));

function roundGeometry(polygons, precision) {
  return polygons.map((rings) => rings.map((ring) => ring.map(([lon, lat]) => [roundCoord(lon, precision), roundCoord(lat, precision)])));
}

function bboxOfPolygons(polygons, precision) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return [roundCoord(minLon, precision), roundCoord(minLat, precision), roundCoord(maxLon, precision), roundCoord(maxLat, precision)];
}

function featureOf(polygons, properties) {
  return {
    type: 'Feature',
    properties,
    geometry: polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons },
  };
}

const vertexCountOf = (polygons) =>
  polygons.reduce((sum, rings) => sum + rings.reduce((ringSum, ring) => ringSum + ring.length, 0), 0);

// ─────────────────────────────────────────────── io

/**
 * One line per feature, compact coordinates. Indenting the coordinate arrays would roughly
 * triple the file size (each position would get its own line and ~16 spaces of indentation)
 * while still keeping clean git diffs, because a changed outline touches exactly one line.
 */
function serializeCollection({ features, ...head }) {
  const headJson = JSON.stringify(head);
  const body = features.length > 0
    ? `\n${features.map((feature) => `  ${JSON.stringify(feature)}`).join(',\n')}\n`
    : '';
  return `${headJson.slice(0, -1)},"features":[${body}]}\n`;
}

async function writeOrCompare(file, contents, check) {
  const previous = existsSync(file) ? await readFile(file, 'utf8') : null;
  if (previous === contents) return false;
  if (check) return true;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
  return true;
}

const toPosix = (value) => value.split(path.sep).join('/');

// ─────────────────────────────────────────────── main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (...args) => { if (!opts.quiet) console.log(...args); };
  const warnings = [];
  const stale = [];

  if (!existsSync(opts.provinces)) {
    console.error(`Province folder not found: ${opts.provinces}`);
    process.exit(2);
  }

  // ── read every province file and group its local units
  /** @type {Map<string, {name:string, type:string, code:string, district:string, polygons:number[][][]}>} */
  const units = new Map();       // "PROV|DISTRICT|NAME" -> unit
  const districtsOf = new Map(); // "PROV|DISTRICT" -> Set of unit keys
  const unitsOf = new Map();     // provKey -> unit keys
  let placemarkCount = 0;

  for (const provKey of Object.keys(PROVINCES)) {
    const file = path.join(opts.provinces, `${provKey}.kml`);
    if (!existsSync(file)) { warnings.push(`missing province file ${provKey}.kml`); continue; }

    const text = await readFile(file, 'utf8');
    const placemarks = parseProvinceKml(text);
    placemarkCount += placemarks.length;
    unitsOf.set(provKey, []);

    for (const placemark of placemarks) {
      if (placemark.polygons.length === 0) { warnings.push(`${provKey}: a placemark has no polygon`); continue; }

      const district = placemark.attrs.DISTRICT_3 || placemark.attrs.District_2 || '';
      const name = placemark.attrs.GAPA_NAP_2 || placemark.attrs.GAPANAPA_1 || '';
      if (!name) { warnings.push(`${provKey}: a placemark has no municipality name`); continue; }
      if (!district) warnings.push(`${provKey}: "${name}" has no district — grouped under UNKNOWN`);

      const districtKey = district || 'UNKNOWN';
      const unitKey = `${provKey}|${districtKey}|${name}`;

      // A unit split over several Placemarks (or listed twice) is merged into one unit.
      let unit = units.get(unitKey);
      if (!unit) {
        unit = {
          name,
          type: placemark.attrs.GN_TYPE_13 || placemark.attrs.GN_TYPE_12 || '',
          code: placemark.attrs.Code || '',
          district: districtKey,
          polygons: [],
        };
        units.set(unitKey, unit);
        unitsOf.get(provKey).push(unitKey);
      }
      unit.polygons.push(...placemark.polygons);

      const districtId = `${provKey}|${districtKey}`;
      if (!districtsOf.has(districtId)) districtsOf.set(districtId, new Set());
      districtsOf.get(districtId).add(unitKey);
    }
  }

  log(`Parsed ${toPosix(path.relative(REPO_ROOT, opts.provinces))}/ — ${placemarkCount} placemark(s) -> ${units.size} local unit(s) in ${districtsOf.size} district(s)`);

  // ── level completion
  const finish = (polygons, level, label) => {
    const tolerance = opts.simplify * (SIMPLIFY_FACTOR[level] ?? 1);
    const kept = [];
    let dropped = 0;
    for (const rings of polygons) {
      const simplifiedRings = [];
      for (const ring of rings) {
        const simplified = simplifyRing(ring, ringTolerance(ring, tolerance));
        if (simplified.length < 4) { dropped++; continue; }
        simplifiedRings.push(simplified);
      }
      if (simplifiedRings.length > 0 && simplifiedRings[0].length >= 4) kept.push(simplifiedRings);
    }
    if (dropped > 0) warnings.push(`${label}: ${dropped} sub-ring(s) too small to keep (${level})`);
    if (kept.length === 0) warnings.push(`${label}: simplification removed all geometry (${level})`);
    return kept;
  };

  /** Dissolves a set of units and validates the result against the input area. */
  const dissolveUnits = (unitKeys, label) => {
    const inputPolygons = unitKeys.flatMap((key) => units.get(key).polygons);
    const expectedArea = netArea(inputPolygons);

    const { rings, cancelled, totalEdges, open } = dissolve(inputPolygons);
    if (open > 0) warnings.push(`${label}: ${open} unclosed ring(s) while dissolving`);
    const polygons = ringsToPolygons(rings);
    if (polygons.length === 0) { warnings.push(`${label}: dissolve produced no polygons`); return null; }

    if (expectedArea > 0) {
      const difference = Math.abs(netArea(polygons) - expectedArea) / expectedArea;
      if (difference > AREA_TOLERANCE) {
        warnings.push(`${label}: dissolved area differs from the unit area by ${(difference * 100).toFixed(3)}%`);
      }
    }

    return { polygons, cancelled, totalEdges };
  };

  // municipality geometry: each unit dissolved against itself to drop internal seams
  const unitGeometry = new Map();
  for (const [unitKey, unit] of units) {
    const { rings, open } = dissolve(unit.polygons);
    if (open > 0) warnings.push(`${unitKey}: ${open} unclosed ring(s) inside a single unit`);
    const polygons = ringsToPolygons(rings);
    if (polygons.length === 0) { warnings.push(`${unitKey}: no geometry after self-dissolve`); continue; }
    unitGeometry.set(unitKey, polygons);
  }

  const districtGeometry = new Map();
  for (const [districtId, unitKeys] of districtsOf) {
    const result = dissolveUnits([...unitKeys], districtId.replace('|', '/'));
    if (result) districtGeometry.set(districtId, result);
  }

  const provinceGeometry = new Map();
  for (const [provKey, unitKeys] of unitsOf) {
    const result = dissolveUnits(unitKeys, provKey);
    if (result) provinceGeometry.set(provKey, result);
  }

  log(`Dissolved ${districtGeometry.size} district(s) and ${provinceGeometry.size} province(s) from ${unitGeometry.size} unit(s)`);

  // ── write
  let written = 0;
  const writeCollection = async (file, collection, label) => {
    if (await writeOrCompare(file, serializeCollection(collection), opts.check)) {
      written++;
      if (opts.check) stale.push(label);
    }
  };

  // country outline (a single feature, only ever drawn zoomed out)
  if (!existsSync(opts.country)) {
    warnings.push(`country outline not found: ${toPosix(path.relative(REPO_ROOT, opts.country))}`);
  } else {
    const countryPolygons = parseGeoJsonPolygons(JSON.parse(await readFile(opts.country, 'utf8')));
    if (countryPolygons.length === 0) {
      warnings.push('country outline contained no polygons');
    } else {
      const geometry = finish(offsetPolygons(countryPolygons, opts.countryNorth, opts.countryEast), 'country', 'country');
      const feature = featureOf(geometry, {
        level: 'country', iso: 'NPL', name: 'Nepal',
        bbox: bboxOfPolygons(geometry, opts.precision),
      });
      log(`  national outline shifted ${opts.countryNorth} m north / ${opts.countryEast} m east`);
      await writeCollection(path.join(opts.out, 'country.json'),
        { schema: SCHEMA, count: 1, offset: { northMeters: opts.countryNorth, eastMeters: opts.countryEast }, features: [feature] }, 'country.json');
    }
  }

  // province outlines in a single file
  const provinceFeatures = [];
  for (const provKey of Object.keys(PROVINCES)) {
    const result = provinceGeometry.get(provKey);
    if (!result) continue;
    const geometry = finish(result.polygons, 'province', provKey);
    const meta = PROVINCES[provKey];
    provinceFeatures.push(featureOf(geometry, {
      level: 'province', province: provKey, npp: meta.npp, name: meta.name,
      districts: [...districtsOf.keys()].filter((id) => id.startsWith(`${provKey}|`)).length,
      municipalities: (unitsOf.get(provKey) ?? []).length,
      bbox: bboxOfPolygons(geometry, opts.precision),
    }));
  }
  await writeCollection(path.join(opts.out, 'province.json'),
    { schema: SCHEMA, count: provinceFeatures.length, features: provinceFeatures }, 'province.json');

  // one file per district: the district outline plus all of its municipalities
  let districtFiles = 0;
  for (const [districtId, unitKeys] of districtsOf) {
    const [provKey, district] = districtId.split('|');
    const result = districtGeometry.get(districtId);
    if (!result) continue;

    const districtOutline = finish(result.polygons, 'district', `${provKey}/${district}`);
    const districtFeature = featureOf(districtOutline, {
      level: 'district', province: provKey, district,
      municipalities: unitKeys.length,
      bbox: bboxOfPolygons(districtOutline, opts.precision),
    });

    const municipalityFeatures = [];
    for (const unitKey of unitKeys) {
      const polygons = unitGeometry.get(unitKey);
      if (!polygons) continue;
      const unit = units.get(unitKey);
      const geometry = finish(polygons, 'municipality', unitKey.replace('|', '/'));
      municipalityFeatures.push(featureOf(geometry, {
        level: 'municipality', province: provKey, district, municipality: unit.name,
        gnType: unit.type, code: unit.code,
        bbox: bboxOfPolygons(geometry, opts.precision),
      }));
    }
    municipalityFeatures.sort((a, b) => a.properties.municipality.localeCompare(b.properties.municipality));

    const file = path.join(opts.out, `${provKey}-${district}.json`);
    await writeCollection(file, {
      schema: SCHEMA, province: provKey, district,
      count: municipalityFeatures.length + 1, municipalities: municipalityFeatures.length,
      features: [districtFeature, ...municipalityFeatures],
    }, `${provKey}-${district}.json`);
    districtFiles++;
  }

  // ── report
  console.log('');
  console.log(`${'prov'.padEnd(6)}${'districts'.padStart(10)}${'units'.padStart(7)}${'municipality vtx'.padStart(18)}${'district vtx'.padStart(14)}${'province vtx'.padStart(14)}`);
  const totals = { units: 0, municipality: 0, district: 0, province: 0 };
  for (const provKey of Object.keys(PROVINCES)) {
    const unitKeys = unitsOf.get(provKey) ?? [];
    const districts = [...districtsOf.keys()].filter((id) => id.startsWith(`${provKey}|`));
    const municipalityVtx = unitKeys.reduce((sum, key) => sum + vertexCountOf(unitGeometry.get(key) ?? []), 0);
    const districtVtx = districts.reduce((sum, id) => sum + vertexCountOf(districtGeometry.get(id)?.polygons ?? []), 0);
    const provinceVtx = vertexCountOf(provinceGeometry.get(provKey)?.polygons ?? []);

    totals.units += unitKeys.length;
    totals.municipality += municipalityVtx;
    totals.district += districtVtx;
    totals.province += provinceVtx;

    console.log(`${provKey.padEnd(6)}${String(districts.length).padStart(10)}${String(unitKeys.length).padStart(7)}${municipalityVtx.toLocaleString('en-US').padStart(18)}${districtVtx.toLocaleString('en-US').padStart(14)}${provinceVtx.toLocaleString('en-US').padStart(14)}`);
  }
  console.log(`${'total'.padEnd(6)}${String(districtsOf.size).padStart(10)}${String(totals.units).padStart(7)}${totals.municipality.toLocaleString('en-US').padStart(18)}${totals.district.toLocaleString('en-US').padStart(14)}${totals.province.toLocaleString('en-US').padStart(14)}`);

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const warning of warnings.slice(0, 40)) console.log(`  - ${warning}`);
    if (warnings.length > 40) console.log(`  ... and ${warnings.length - 40} more`);
  }

  if (opts.check) {
    if (stale.length > 0) {
      console.error(`\n${stale.length} outline file(s) missing or stale:`);
      for (const file of stale.slice(0, 20)) console.error(`  - ${file}`);
      console.error('\nRun: node tools/build-kml-outlines.mjs');
      process.exit(1);
    }
    console.log('\nOutlines are up to date.');
    return;
  }

  console.log(`\nWrote ${written} outline file(s) (${districtFiles} district file(s)) to ${toPosix(path.relative(REPO_ROOT, opts.out))}/`);

  const produced = (await readdir(opts.out)).filter((name) => name.endsWith('.json'));
  let bytes = 0;
  let largest = { name: '', size: 0 };
  for (const name of produced) {
    const { size } = await stat(path.join(opts.out, name));
    bytes += size;
    if (size > largest.size) largest = { name, size };
  }
  console.log(`${produced.length} file(s), ${(bytes / 1048576).toFixed(2)} MB total, largest ${largest.name} (${(largest.size / 1024).toFixed(0)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
