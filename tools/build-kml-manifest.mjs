#!/usr/bin/env node
/**
 * tools/build-kml-manifest.mjs
 *
 * Walks KML_Nepal/ and writes the two-tier bounding-box manifests consumed by
 * WME-NP-GIS-Layers.js, so only the KML layers intersecting the map viewport are loaded:
 *
 *   KML_Nepal/index.json          -> province tier (tiny, always fetched)
 *   KML_Nepal/<PROV>/index.json   -> municipality tier (fetched only when that province is in view)
 *
 * Layout assumed: KML_Nepal/<PROV>/<DISTRICT>/<Municipality>/<PROV>_<DISTRICT>_<Municipality>.kml
 *
 * Zero dependencies.
 *
 *   node tools/build-kml-manifest.mjs
 *   node tools/build-kml-manifest.mjs --check
 *   node tools/build-kml-manifest.mjs --root=KML_Nepal --pad=0.001 --precision=6 --quiet
 */

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/** Folder key -> wmeGisLBBOX first-level subdivision id (NPL, Sub_level 1). */
const PROVINCES = {
  KO: { npp: 'NPP1', name: 'Koshi' },
  MA: { npp: 'NPP2', name: 'Madhesh' },
  BA: { npp: 'NPP3', name: 'Bagmati' },
  GA: { npp: 'NPP4', name: 'Gandaki' },
  LU: { npp: 'NPP5', name: 'Lumbini' },
  KA: { npp: 'NPP6', name: 'Karnali' },
  SU: { npp: 'NPP7', name: 'Sudurpashchim' },
};

/** Loose sanity envelope for Nepal (WGS84). */
const NEPAL_BOUNDS = { minLon: 79.5, minLat: 25.5, maxLon: 89.0, maxLat: 31.0 };

const SCHEMA = 1;

// ─────────────────────────────────────────────── args

function printUsage() {
  console.log(`Usage: node tools/build-kml-manifest.mjs [options]

  --root=<dir>      KML root folder (default: <repo>/KML_Nepal)
  --pad=<deg>       Expand each bbox by this many degrees (default: 0.0005)
  --precision=<n>   Decimal places for bbox values (default: 6)
  --check           Do not write; exit 1 if any manifest is missing or stale
  --quiet           Only print warnings and the final summary
  -h, --help        Show this help`);
}

function parseArgs(argv) {
  const opts = {
    root: path.join(REPO_ROOT, 'KML_Nepal'),
    pad: 0.0005,
    precision: 6,
    check: false,
    quiet: false,
  };

  for (const arg of argv) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '-h' || arg === '--help') { printUsage(); process.exit(0); }
    else if (arg.startsWith('--root=')) opts.root = path.resolve(REPO_ROOT, arg.slice(7));
    else if (arg.startsWith('--pad=')) opts.pad = Number(arg.slice(6));
    else if (arg.startsWith('--precision=')) opts.precision = Number(arg.slice(12));
    else { console.error(`Unknown option: ${arg}\n`); printUsage(); process.exit(2); }
  }

  if (!Number.isFinite(opts.pad) || opts.pad < 0) { console.error('--pad must be a non-negative number'); process.exit(2); }
  if (!Number.isInteger(opts.precision) || opts.precision < 0 || opts.precision > 12) { console.error('--precision must be an integer 0-12'); process.exit(2); }
  return opts;
}

// ─────────────────────────────────────────────── helpers

/** Normalises a name for folder-vs-metadata comparison ("Pokhara_Lekhnath" == "Pokhara Lekhnath"). */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
      if (entity[0] === '#') {
        const code = entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return XML_ENTITIES[entity] ?? match;
    });
}

/**
 * Collects <SimpleData name="...">value</SimpleData> pairs.
 * <SimpleField name="..."/> declarations inside <Schema> are ignored by design.
 */
function parseSimpleData(text) {
  const out = {};
  const re = /<SimpleData\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/SimpleData>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const key = decodeXml(match[1]).trim();
    if (key && out[key] === undefined) out[key] = decodeXml(match[2]).trim();
  }
  return out;
}

/**
 * Unions every <coordinates> tuple in the document.
 * KML tuples are "lon,lat[,alt]" separated by whitespace.
 * @returns {{ bbox: number[], points: number }|null}
 */
function computeBbox(text) {
  const re = /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/gi;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity, points = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    for (const tuple of match[1].trim().split(/\s+/)) {
      if (!tuple) continue;
      const comma = tuple.indexOf(',');
      if (comma === -1) continue;

      const lon = Number(tuple.slice(0, comma));
      const lat = Number(tuple.slice(comma + 1).split(',')[0]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
      points++;
    }
  }

  return points === 0 ? null : { bbox: [minLon, minLat, maxLon, maxLat], points };
}

const round = (value, precision) => Number(value.toFixed(precision));

function padBbox(bbox, pad, precision) {
  return [
    round(bbox[0] - pad, precision),
    round(bbox[1] - pad, precision),
    round(bbox[2] + pad, precision),
    round(bbox[3] + pad, precision),
  ];
}

function unionBbox(bboxes) {
  return bboxes.reduce(
    (acc, b) => [
      Math.min(acc[0], b[0]),
      Math.min(acc[1], b[1]),
      Math.max(acc[2], b[2]),
      Math.max(acc[3], b[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

const outsideNepal = (bbox) =>
  bbox[0] < NEPAL_BOUNDS.minLon || bbox[1] < NEPAL_BOUNDS.minLat ||
  bbox[2] > NEPAL_BOUNDS.maxLon || bbox[3] > NEPAL_BOUNDS.maxLat;

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.kml')) out.push(full);
  }
  return out;
}

const toPosix = (relativePath) => relativePath.split(path.sep).join('/');
const serialize = (value) => JSON.stringify(value, null, 2) + '\n';

/** @returns {boolean} true when the file was written, or (check mode) is stale. */
async function writeOrCompare(file, contents, check) {
  const previous = existsSync(file) ? await readFile(file, 'utf8') : null;
  if (previous === contents) return false;
  if (check) return true;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
  return true;
}

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

  log(`Scanning ${toPosix(path.relative(REPO_ROOT, opts.root))}/ ...`);
  const files = (await walk(opts.root)).sort();
  log(`Found ${files.length} .kml file(s).`);

  /** @type {Map<string, any[]>} provinceKey -> items */
  const byProvince = new Map(Object.keys(PROVINCES).map((key) => [key, []]));
  let totalVertices = 0;

  for (const file of files) {
    const rel = toPosix(path.relative(opts.root, file));
    const parts = rel.split('/');
    const provinceKey = parts[0];

    if (parts.length !== 4) {
      warnings.push(`unexpected folder depth (${parts.length}): ${rel}`);
      continue;
    }
    if (!byProvince.has(provinceKey)) {
      warnings.push(`unknown province folder "${provinceKey}": ${rel}`);
      continue;
    }

    const text = await readFile(file, 'utf8');
    const simpleData = parseSimpleData(text);
    const geometry = computeBbox(text);

    if (!geometry) {
      warnings.push(`no <coordinates> found: ${rel}`);
      continue;
    }

    const districtFolder = parts[1];
    const municipalityFolder = parts[2];

    const metaProvince = simpleData['Province'];
    const metaDistrict = simpleData['district'];
    const metaMunicipality = simpleData['gapa_napa'];

    if (metaProvince && norm(metaProvince) !== norm(provinceKey)) {
      warnings.push(`Province mismatch: metadata "${metaProvince}" vs folder "${provinceKey}": ${rel}`);
    }
    if (metaDistrict && norm(metaDistrict) !== norm(districtFolder)) {
      warnings.push(`district mismatch: metadata "${metaDistrict}" vs folder "${districtFolder}": ${rel}`);
    }
    if (metaMunicipality && norm(metaMunicipality) !== norm(municipalityFolder)) {
      warnings.push(`gapa_napa mismatch: metadata "${metaMunicipality}" vs folder "${municipalityFolder}": ${rel}`);
    }

    const bbox = padBbox(geometry.bbox, opts.pad, opts.precision);
    if (outsideNepal(bbox)) warnings.push(`bbox outside Nepal envelope: ${rel} -> [${bbox.join(', ')}]`);

    const { size } = await stat(file);
    totalVertices += geometry.points;

    byProvince.get(provinceKey).push({
      district: districtFolder,
      municipality: municipalityFolder,
      type: simpleData['type_gn'] || null,
      wards: (text.match(/<Placemark\b/gi) || []).length,
      size,
      file: rel,
      bbox,
    });
  }

  // ── province tier + per-province manifests
  const provinces = {};
  let totalMunicipalities = 0;

  const provinceKeys = Object.keys(PROVINCES)
    .sort((a, b) => PROVINCES[a].npp.localeCompare(PROVINCES[b].npp));

  for (const key of provinceKeys) {
    const items = byProvince.get(key).sort(
      (a, b) => a.district.localeCompare(b.district)
        || a.municipality.localeCompare(b.municipality)
        || a.file.localeCompare(b.file),
    );

    if (items.length === 0) {
      warnings.push(`no KML files found for province "${key}"`);
      continue;
    }

    const bbox = unionBbox(items.map((item) => item.bbox));
    const { npp, name } = PROVINCES[key];
    totalMunicipalities += items.length;

    provinces[key] = { npp, name, bbox, count: items.length, index: `${key}/index.json` };

    const provinceManifest = serialize({
      schema: SCHEMA,
      province: key,
      npp,
      name,
      bbox,
      count: items.length,
      items,
    });

    if (await writeOrCompare(path.join(opts.root, key, 'index.json'), provinceManifest, opts.check) && opts.check) {
      stale.push(`${key}/index.json`);
    }
  }

  const rootManifest = serialize({
    schema: SCHEMA,
    source: 'KML_Nepal',
    bboxOrder: ['minLon', 'minLat', 'maxLon', 'maxLat'],
    counts: {
      provinces: Object.keys(provinces).length,
      municipalities: totalMunicipalities,
      vertices: totalVertices,
    },
    provinces,
  });

  if (await writeOrCompare(path.join(opts.root, 'index.json'), rootManifest, opts.check) && opts.check) {
    stale.push('index.json');
  }

  // ── report
  console.log('');
  console.log(`${'prov'.padEnd(6)}${'npp'.padEnd(7)}${'files'.padStart(6)}  bbox`);
  for (const [key, info] of Object.entries(provinces)) {
    console.log(`${key.padEnd(6)}${info.npp.padEnd(7)}${String(info.count).padStart(6)}  [${info.bbox.join(', ')}]`);
  }
  console.log('');
  console.log(`Total: ${totalMunicipalities} municipalities, ${totalVertices.toLocaleString('en-US')} vertices`);

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const warning of warnings) console.log(`  - ${warning}`);
  }

  if (opts.check) {
    if (stale.length > 0) {
      console.error(`\n${stale.length} manifest file(s) missing or stale:`);
      for (const file of stale) console.error(`  - ${file}`);
      console.error('\nRun: node tools/build-kml-manifest.mjs');
      process.exit(1);
    }
    console.log('\nManifests are up to date.');
    return;
  }

  console.log(`\nWrote ${Object.keys(provinces).length + 1} manifest file(s) under ${toPosix(path.relative(REPO_ROOT, opts.root))}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
