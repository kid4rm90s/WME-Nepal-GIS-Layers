#!/usr/bin/env node
/**
 * tools/build-kml-outlines.mjs
 *
 * Builds dissolved (union) outline GeoJSON for the three parent administrative levels,
 * so Province / District / Municipality can be drawn as clean boundary lines.
 *
 * Why this is needed: every KML in KML_Nepal/ is ONE municipality whose wards are separate
 * <Polygon> Placemarks that tile the municipality. Stroking those polygons directly would
 * draw every internal ward line, so the parent levels need a real dissolve.
 *
 * Zero dependencies. The dissolve is done by EDGE CANCELLATION: neighbouring units come from
 * the same source dataset, so a shared border appears as the same vertex pair in opposite
 * directions inside the two polygons. Cancelling those pairs leaves exactly the boundary
 * edges, which are then chained into closed rings (measured: 95.7% of the edges of a whole
 * province cancel out, i.e. only ~4% of edges are real boundary).
 *
 * Hierarchy is built bottom-up so each level reuses the previous one:
 *   wards        -> municipality outline   (per owner)
 *   municipalities -> district outline     (per district)
 *   districts    -> province outline       (per province)
 *
 * Output (default KML_Nepal/outlines/) — 78 files:
 *   province.json              FeatureCollection, one feature per province (7)
 *   <PROV>-<DISTRICT>.json     the district's own outline + all of its municipalities
 *
 * One file per district serves both parent levels below the province, so the client only ever
 * downloads the handful of districts that are actually in view.
 *
 * Every feature carries a bbox property ([minLon, minLat, maxLon, maxLat]) so the userscript
 * can test features against the map viewport without extra fetches.
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

const SCHEMA = 1;
const SNAP_DECIMALS = 6; // ~0.11 m grid; guarantees shared borders hash to the same key

// Coarse levels can afford a coarser outline: they are only ever drawn zoomed out.
const SIMPLIFY_FACTOR = { municipality: 1, district: 2, province: 4 };
const ORIGINAL_VERTEX_FLOOR = 12; // warn when simplification leaves less than this

// ─────────────────────────────────────────────── args

function printUsage() {
  console.log(`Usage: node tools/build-kml-outlines.mjs [options]

  --root=<dir>        KML root folder (default: <repo>/KML_Nepal)
  --out=<dir>         Output folder (default: <root>/outlines)
  --simplify=<deg>    Douglas-Peucker tolerance in degrees (default: 0.0001, 0 disables)
  --precision=<n>     Decimal places for output coordinates (default: 6)
  --check             Do not write; exit 1 if any output is missing or stale
  --quiet             Only print warnings and the final summary
  -h, --help          Show this help`);
}

function parseArgs(argv) {
  const opts = {
    root: path.join(REPO_ROOT, 'KML_Nepal'),
    out: null,
    simplify: 0.0001,
    precision: 6,
    check: false,
    quiet: false,
  };

  for (const arg of argv) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '-h' || arg === '--help') { printUsage(); process.exit(0); }
    else if (arg.startsWith('--root=')) opts.root = path.resolve(REPO_ROOT, arg.slice(7));
    else if (arg.startsWith('--out=')) opts.out = path.resolve(REPO_ROOT, arg.slice(6));
    else if (arg.startsWith('--simplify=')) opts.simplify = Number(arg.slice(11));
    else if (arg.startsWith('--precision=')) opts.precision = Number(arg.slice(12));
    else { console.error(`Unknown option: ${arg}\n`); printUsage(); process.exit(2); }
  }

  if (!opts.out) opts.out = path.join(opts.root, 'outlines');
  if (!Number.isFinite(opts.simplify) || opts.simplify < 0) { console.error('--simplify must be >= 0'); process.exit(2); }
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

/** Extracts every <Polygon> of a KML as [shell, ...holes], with shells CCW and holes CW. */
function parseKmlPolygons(text) {
  const polygons = [];
  const polyRe = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/gi;
  let polyMatch;

  while ((polyMatch = polyRe.exec(text)) !== null) {
    const rings = [];
    const ringRe = /<LinearRing\b[^>]*>([\s\S]*?)<\/LinearRing>/gi;
    let ringMatch;

    while ((ringMatch = ringRe.exec(polyMatch[1])) !== null) {
      const coordsMatch = /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/i.exec(ringMatch[1]);
      if (!coordsMatch) continue;

      const ring = [];
      for (const tuple of coordsMatch[1].trim().split(/\s+/)) {
        if (!tuple) continue;
        const comma = tuple.indexOf(',');
        if (comma === -1) continue;
        const lon = Number(tuple.slice(0, comma));
        const lat = Number(tuple.slice(comma + 1).split(',')[0]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        ring.push([snap(lon), snap(lat)]);
      }

      // drop duplicated consecutive vertices, then ensure closure
      const cleaned = ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
      if (cleaned.length >= 3) {
        if (cleaned[0][0] !== cleaned[cleaned.length - 1][0] || cleaned[0][1] !== cleaned[cleaned.length - 1][1]) {
          cleaned.push([cleaned[0][0], cleaned[0][1]]);
        }
        if (cleaned.length >= 4) rings.push(cleaned);
      }
    }

    if (rings.length === 0) continue;

    // Largest ring is the shell regardless of element order; the rest are holes.
    rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const normalised = rings.map((ring, index) => {
      const isShell = index === 0;
      const ccw = signedArea(ring) > 0;
      return ccw === isShell ? ring : ring.slice().reverse();
    });
    polygons.push(normalised);
  }

  return polygons;
}

/**
 * Cancels shared edges between all polygons of a group and chains the remainder into rings.
 * @returns {{ polygons: number[][][], kept: number, cancelled: number, open: number }}
 */
function dissolve(polygons) {
  const edgeCount = new Map();
  const points = new Map();
  let total = 0;

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
        total++;
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
  let kept = 0;
  for (const pair of pairs) {
    const [a, b] = pair.split('|');
    const ab = edgeCount.get(`${a}|${b}`) || 0;
    const ba = edgeCount.get(`${b}|${a}`) || 0;
    const drop = Math.min(ab, ba);
    cancelled += drop * 2;
    const remainAB = ab - drop;
    const remainBA = ba - drop;
    if (remainAB > 0) { pushEdge(a, b, remainAB); kept += remainAB; }
    if (remainBA > 0) { pushEdge(b, a, remainBA); kept += remainBA; }
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

  return { rings, kept, cancelled, open };
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
 * Small islands and riverine slivers would be flattened away by the tolerance used for the
 * main boundary, so scale the tolerance down for short rings (~5% of their own size).
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

const countVertices = (polygons) =>
  polygons.reduce((sum, rings) => sum + rings.reduce((ringSum, ring) => ringSum + ring.length, 0), 0);

function featureOf(polygons, properties) {
  return {
    type: 'Feature',
    properties,
    geometry: polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons },
  };
}

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

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.kml')) out.push(full);
  }
  return out;
}

const toPosix = (value) => value.split(path.sep).join('/');

// ─────────────────────────────────────────────── main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (...args) => { if (!opts.quiet) console.log(...args); };
  const warnings = [];
  const stale = [];

  if (!existsSync(opts.root)) {
    console.error(`KML root not found: ${opts.root}`);
    process.exit(2);
  }

  const files = (await walk(opts.root)).sort();
  log(`Scanning ${toPosix(path.relative(REPO_ROOT, opts.root))}/ — ${files.length} .kml file(s)`);

  /** @type {Map<string, {province:string, district:string, municipality:string, files:string[]}>} */
  const byMunicipality = new Map();
  for (const file of files) {
    const parts = toPosix(path.relative(opts.root, file)).split('/');
    if (parts.length !== 4) continue;
    const key = `${parts[0]}|${parts[1]}|${parts[2]}`;
    if (!byMunicipality.has(key)) {
      byMunicipality.set(key, { province: parts[0], district: parts[1], municipality: parts[2], files: [] });
    }
    byMunicipality.get(key).files.push(file);
  }

  // ── level 1: municipality outlines (wards dissolved)
  /** @type {Map<string, {polygons:number[][][], entry:any}>} */
  const municipalities = new Map();
  let wardCount = 0;

  for (const [key, entry] of byMunicipality) {
    const polygons = [];
    for (const file of entry.files) {
      polygons.push(...parseKmlPolygons(await readFile(file, 'utf8')));
    }
    if (polygons.length === 0) { warnings.push(`no polygons parsed for ${key}`); continue; }
    wardCount += polygons.length;

    const { rings, kept, cancelled, open } = dissolve(polygons);
    if (open > 0) warnings.push(`${key}: ${open} unclosed ring(s) while dissolving wards`);
    if (kept === 0) { warnings.push(`${key}: dissolve produced no edges`); continue; }

    const dissolved = ringsToPolygons(rings);
    if (dissolved.length === 0) { warnings.push(`${key}: dissolve produced no polygons`); continue; }
    municipalities.set(key, { polygons: dissolved, entry });
  }

  log(`  municipalities dissolved: ${municipalities.size} (from ${wardCount} ward polygons)`);

  // ── level 2: district outlines (municipalities dissolved)
  /** @type {Map<string, {province:string, district:string, polygons:number[][][], municipalities:any[]}>} */
  const districts = new Map();
  for (const { polygons, entry } of municipalities.values()) {
    const key = `${entry.province}|${entry.district}`;
    if (!districts.has(key)) {
      districts.set(key, { province: entry.province, district: entry.district, polygons: [], municipalities: [] });
    }
    districts.get(key).polygons.push(...polygons);
    districts.get(key).municipalities.push(entry);
  }

  const districtOutlines = new Map();
  for (const [key, group] of districts) {
    const { rings, open } = dissolve(group.polygons);
    if (open > 0) warnings.push(`${key}: ${open} unclosed ring(s) while dissolving municipalities`);
    const dissolved = ringsToPolygons(rings);
    if (dissolved.length === 0) { warnings.push(`${key}: no district outline produced`); continue; }
    districtOutlines.set(key, { province: group.province, district: group.district, polygons: dissolved });
  }
  log(`  districts dissolved: ${districtOutlines.size}`);

  // ── level 3: province outlines (districts dissolved)
  const provinceOutlines = new Map();
  for (const group of districtOutlines.values()) {
    if (!provinceOutlines.has(group.province)) provinceOutlines.set(group.province, { provinces: [], polygons: [] });
    const bucket = provinceOutlines.get(group.province);
    bucket.polygons.push(...group.polygons);
    bucket.provinces.push(group.district);
  }

  const finalProvinces = new Map();
  for (const [provinceKey, group] of provinceOutlines) {
    const { rings, open } = dissolve(group.polygons);
    if (open > 0) warnings.push(`${provinceKey}: ${open} unclosed ring(s) while dissolving districts`);
    const dissolved = ringsToPolygons(rings);
    if (dissolved.length === 0) { warnings.push(`${provinceKey}: no province outline produced`); continue; }
    finalProvinces.set(provinceKey, dissolved);
  }
  log(`  provinces dissolved: ${finalProvinces.size}`);

  // ── write
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
    return roundGeometry(kept, opts.precision);
  };

  let written = 0;

  // ── district features — computed once, then reused by the province file
  const districtFeatures = new Map(); // "PROV|DISTRICT" -> feature
  for (const [key, group] of districtOutlines) {
    const geometry = finish(group.polygons, 'district', key);
    districtFeatures.set(key, featureOf(geometry, {
      level: 'district', province: group.province, district: group.district,
      municipalities: [...municipalities.keys()].filter((k) => k.startsWith(`${key}|`)).length,
      bbox: bboxOfPolygons(geometry, opts.precision),
    }));
  }

  // ── municipality features, grouped by district
  const municipalityFeatures = new Map(); // "PROV|DISTRICT" -> feature[]
  for (const [key, value] of municipalities) {
    const [prov, district] = key.split('|');
    const geometry = finish(value.polygons, 'municipality', key);
    const group = municipalityFeatures.get(`${prov}|${district}`) ?? [];
    group.push(featureOf(geometry, {
      level: 'municipality', province: prov, district,
      municipality: value.entry.municipality,
      bbox: bboxOfPolygons(geometry, opts.precision),
    }));
    municipalityFeatures.set(`${prov}|${district}`, group);
  }

  /**
   * One file per district holding the district's own dissolved outline plus every municipality
   * in it, so the client can serve both the district and the municipality level from a single
   * small download (only the districts actually in view are ever fetched).
   */
  for (const [key, districtFeature] of districtFeatures) {
    const [prov, district] = key.split('|');
    const group = (municipalityFeatures.get(key) ?? [])
      .sort((a, b) => a.properties.municipality.localeCompare(b.properties.municipality));
    const file = path.join(opts.out, `${prov}-${district}.json`);
    const collection = {
      schema: SCHEMA, province: prov, district,
      count: group.length + 1, municipalities: group.length,
      features: [districtFeature, ...group],
    };
    if (await writeOrCompare(file, serializeCollection(collection), opts.check)) {
      written++;
      if (opts.check) stale.push(`${prov}-${district}.json`);
    }
  }

  // ── province outlines: a single small file, fetched at most once per session
  const provinceFeatures = [];
  for (const provinceKey of Object.keys(PROVINCES).sort((a, b) => PROVINCES[a].npp.localeCompare(PROVINCES[b].npp))) {
    const polygons = finalProvinces.get(provinceKey);
    if (!polygons) continue;

    const geometry = finish(polygons, 'province', provinceKey);
    const meta = PROVINCES[provinceKey];
    provinceFeatures.push(featureOf(geometry, {
      level: 'province', province: provinceKey, npp: meta.npp, name: meta.name,
      districts: [...districtOutlines.values()].filter((d) => d.province === provinceKey).length,
      bbox: bboxOfPolygons(geometry, opts.precision),
    }));
  }

  provinceFeatures.sort((a, b) => a.properties.province.localeCompare(b.properties.province));
  const provinceFile = path.join(opts.out, 'province.json');
  if (await writeOrCompare(provinceFile, serializeCollection({ schema: SCHEMA, count: provinceFeatures.length, features: provinceFeatures }), opts.check)) {
    written++;
    if (opts.check) stale.push('province.json');
  }

  // ── report
  console.log('');
  console.log(`${'prov'.padEnd(6)}${'districts'.padStart(10)}${'municipalities'.padStart(15)}${'vertices'.padStart(11)}`);
  for (const provinceKey of Object.keys(PROVINCES).sort((a, b) => PROVINCES[a].npp.localeCompare(PROVINCES[b].npp))) {
    const districtsOfProvince = [...districtOutlines.values()].filter((d) => d.province === provinceKey);
    const municipalitiesOfProvince = [...municipalities.keys()].filter((k) => k.startsWith(`${provinceKey}|`));
    const verticesThisProvince = [...municipalities.entries()]
      .filter(([key]) => key.startsWith(`${provinceKey}|`))
      .reduce((sum, [, value]) => sum + countVertices(value.polygons), 0);
    console.log(`${provinceKey.padEnd(6)}${String(districtsOfProvince.length).padStart(10)}${String(municipalitiesOfProvince.length).padStart(15)}${verticesThisProvince.toLocaleString('en-US').padStart(11)}`);
  }

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

  console.log(`\nWrote ${written} outline file(s) to ${toPosix(path.relative(REPO_ROOT, opts.out))}/`);

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
