// Ingest: read the private "Future Festivals" tab via the Google Sheets API,
// parse rows, geocode addresses (cached), and write public/fest-map/data.json.
//
// Env:
//   GOOGLE_SERVICE_ACCOUNT_KEY  service-account JSON (string)   [CI]
//   GOOGLE_APPLICATION_CREDENTIALS  path to that JSON           [local alt]
//   SHEET_ID    spreadsheet id (defaults to the Festhome sheet)
//   TZ_OFFSET   hours offset for "today" when flagging past events (default -3)
//
// A normal run does zero network geocoding: every address already lives in
// ingest/geocache.json. Only brand-new festivals hit Nominatim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import { parseRows } from './parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_PATH = path.join(HERE, 'geocache.json');
const OUT_PATH = path.join(ROOT, 'public/fest-map/data.json');

const SHEET_ID = process.env.SHEET_ID || '1Ie60CKn3zlt5MFB43nt5GM6h6gbAO-p1wDvaTmB27xk';
const TAB = 'Future Festivals';
const TZ_OFFSET = process.env.TZ_OFFSET != null ? parseFloat(process.env.TZ_OFFSET) : -3;
const FIELD_ORDER = ['id', 'name', 'country', 'cats', 'start', 'end', 'deadline',
  'opens', 'status', 'url', 'lat', 'lon', 'prec', 'inactive', 'warn'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayISO = () => new Date(Date.now() + TZ_OFFSET * 3600000).toISOString().slice(0, 10);

function loadAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const creds = raw
    ? JSON.parse(raw)
    : JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function fetchRows(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A1:M`,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  if (!res.data.values || res.data.values.length < 2) throw new Error(`empty range '${TAB}'`);
  return res.data.values;
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
  const values = await fetchRows(loadAuth());
  const today = todayISO();
  const items = parseRows(values, today);
  console.log(`parsed ${items.length} festivals (today=${today}, tz=GMT${TZ_OFFSET >= 0 ? '+' : ''}${TZ_OFFSET})`);

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
  const geoMissing = out.filter((r) => r.lat == null).length;
  console.log(`wrote ${out.length} -> ${path.relative(ROOT, OUT_PATH)}  (geocode calls: ${geocodeCalls}, missing coords: ${geoMissing})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
