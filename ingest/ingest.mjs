// Ingest: read the public "Future Festivals" sheet tab as CSV, parse rows,
// geocode addresses (cached), and write public/fest-map/data.json.
//
// The sheet must be shared "Anyone with the link → Viewer" (it only holds
// public Festhome data). No Google credentials required.
//
// Env:
//   SHEET_ID    spreadsheet id (defaults to the Festhome sheet)
//   CSV_URL     full CSV url override (defaults to the gviz export below)
//
// "Past event" greying is decided live on the map (end-date based, vs. the
// user's selected timezone), so no run-date logic lives here.
//
// A normal run does zero network geocoding: every address already lives in
// ingest/geocache.json. Only brand-new festivals hit Nominatim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRows, parseCsv } from './parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_PATH = path.join(HERE, 'geocache.json');
const OUT_PATH = path.join(ROOT, 'public/fest-map/data.json');
const META_PATH = path.join(ROOT, 'public/fest-map/meta.json');

const SHEET_ID = process.env.SHEET_ID || '1Ie60CKn3zlt5MFB43nt5GM6h6gbAO-p1wDvaTmB27xk';
const TAB = 'Future Festivals';
const CSV_URL = process.env.CSV_URL ||
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(TAB)}`;
const FIELD_ORDER = ['id', 'name', 'country', 'cats', 'start', 'end', 'deadline',
  'opens', 'status', 'url', 'email', 'website', 'instagram', 'facebook',
  'lat', 'lon', 'prec', 'inactive', 'warn'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchValues() {
  const r = await fetch(CSV_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`sheet fetch HTTP ${r.status} — is it shared "Anyone with the link"?`);
  const text = await r.text();
  if (/^\s*</.test(text)) {
    throw new Error('got HTML, not CSV — the sheet is not publicly readable (check link sharing)');
  }
  const values = parseCsv(text);
  if (values.length < 2) throw new Error('CSV had no data rows');
  return values;
}

// --- geocoding (Nominatim, cached) ---
const cache = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) : {};
let geocodeCalls = 0;

async function nominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': 'ingest.mov-festmap/1.0 (vinicius.leite@gmail.com)' } });
  if (!r.ok) throw new Error('nominatim HTTP ' + r.status);
  geocodeCalls++;
  await sleep(1100); // respect Nominatim's 1 req/s policy
  const j = await r.json();
  return j[0] ? { lat: +(+j[0].lat).toFixed(5), lon: +(+j[0].lon).toFixed(5) } : null;
}

async function geocode(addr, country) {
  if (addr && cache[addr]) return cache[addr];
  let res = null;
  if (addr) {
    const hit = await nominatim(addr).catch((e) => (console.warn('geocode addr fail:', addr, e.message), null));
    if (hit) res = { ...hit, prec: 'city' };
  }
  if (!res && country) {
    const ckey = 'country:' + country;
    if (cache[ckey]) res = cache[ckey];
    else {
      const hit = await nominatim(country).catch(() => null);
      res = hit ? { ...hit, prec: 'country' } : { lat: null, lon: null, prec: 'country' };
      cache[ckey] = res;
    }
  }
  res = res || { lat: null, lon: null, prec: 'country' };
  if (addr) cache[addr] = res;
  return res;
}

async function main() {
  const values = await fetchValues();
  const items = parseRows(values);
  console.log(`parsed ${items.length} festivals`);

  const out = [];
  for (const f of items) {
    const { addr, ...rec } = f;
    const geo = await geocode(addr, rec.country);
    rec.lat = geo.lat; rec.lon = geo.lon; rec.prec = geo.prec;
    out.push(Object.fromEntries(FIELD_ORDER.map((k) => [k, rec[k]])));
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0));
  // one record per line: valid JSON array, but git-diff friendly
  fs.writeFileSync(OUT_PATH, '[\n' + out.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
  // sidecar: when this data was generated, so the map can show "updated Nh ago"
  // and the refresh button can detect when a fresh build has landed. Not tracked
  // in git (changes every run) — it's regenerated + deployed on each ingest.
  fs.writeFileSync(META_PATH, JSON.stringify({ generated: new Date().toISOString(), count: out.length }) + '\n');
  const geoMissing = out.filter((r) => r.lat == null).length;
  console.log(`wrote ${out.length} -> ${path.relative(ROOT, OUT_PATH)}  (geocode calls: ${geocodeCalls}, missing coords: ${geoMissing})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
