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
import { parseRows, parseFFRows, parseSFDRows, parseFARows, parseMBPage, parseMBRows, parseCsv } from './parse.mjs';
import { applyContacts } from './contacts-parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_PATH = path.join(HERE, 'geocache.json');
const CONTACTS_PATH = path.join(HERE, 'contacts.json'); // written by contacts.mjs; merged here, never fetched
const OUT_PATH = path.join(ROOT, 'public/fest-map/data.json');
const META_PATH = path.join(ROOT, 'public/fest-map/meta.json');
const OUT_FF_PATH = path.join(ROOT, 'public/fest-map/data-ff.json');
const OUT_SFD_PATH = path.join(ROOT, 'public/fest-map/data-sfd.json');
const OUT_FA_PATH = path.join(ROOT, 'public/fest-map/data-fa.json');
const OUT_MB_PATH = path.join(ROOT, 'public/fest-map/data-mb.json');
const FF_DATES_PATH = path.join(HERE, 'filmfreeway-dates.json'); // browser-scraped, committed

const SHEET_ID = process.env.SHEET_ID || '1Ie60CKn3zlt5MFB43nt5GM6h6gbAO-p1wDvaTmB27xk';
const TAB = 'Future Festivals';
const TAB_FF = 'FilmFreeway';
const csvUrl = (tab) => `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
const CSV_URL = process.env.CSV_URL || csvUrl(TAB);
const CSV_URL_FF = process.env.CSV_URL_FF || csvUrl(TAB_FF);
const FIELD_ORDER = ['id', 'name', 'country', 'cats', 'start', 'end', 'deadline',
  'opens', 'status', 'url', 'email', 'website', 'instagram', 'facebook',
  'lat', 'lon', 'prec', 'inactive', 'warn'];
const FF_FIELD_ORDER = ['id', 'src', 'name', 'country', 'location', 'start', 'end',
  'deadline', 'opens', 'status', 'years', 'badges', 'url', 'slug',
  'lat', 'lon', 'prec', 'inactive', 'warn', 'hasDates'];
const SFD_FIELD_ORDER = ['id', 'src', 'name', 'country', 'location', 'start', 'end',
  'deadline', 'opens', 'status', 'comps', 'feeMin', 'feeMax', 'email', 'website', 'instagram', 'facebook', 'url', 'slug',
  'lat', 'lon', 'prec', 'inactive', 'warn', 'hasDates'];
const FA_FIELD_ORDER = ['id', 'src', 'name', 'country', 'location', 'start', 'end',
  'deadline', 'opens', 'status', 'years', 'free', 'email', 'website', 'instagram', 'facebook', 'url', 'slug',
  'lat', 'lon', 'prec', 'inactive', 'warn', 'hasDates'];
const MB_FIELD_ORDER = ['id', 'src', 'name', 'country', 'location', 'start', 'end',
  'deadline', 'opens', 'status', 'feeMin', 'feeMax', 'qualifying', 'email', 'website', 'instagram', 'facebook', 'url', 'slug',
  'lat', 'lon', 'prec', 'inactive', 'warn', 'hasDates'];

// Shortfilmdepot's public API. No key, no cookie: the site's own front end calls
// these anonymously (CORS hides that from a browser, but server-side it is open).
// skip/take go in the BODY — passing them only in the path returns a single row.
const SFD_API = process.env.SFD_API || 'https://apiv3-user.shortfilmdepot.com';
const UA = 'ingest.mov-festmap/1.0 (+https://ingest.mov)'; // how this ingest identifies itself to each source
const SFD_TAKE = 2000; // whole catalogue is ~219 rows; one request is plenty
// sort block copied from the site's own request, so we get the same ordering
// (and the same code path) rather than whatever the API defaults to
const SFD_SORT_LEGACY = [
  { Key: 'StatutCampagne', Value: true },
  { Key: 'FermetureCampagne', Value: false },
  { Key: 'DebutCampagne', Value: false },
];
const SFD_SORT = [
  { Property: 'StatutCampagne', Priority: 0, IsDesc: true },
  { Property: 'FermetureCampagne', Priority: 1, IsDesc: false },
  { Property: 'DebutCampagne', Priority: 2, IsDesc: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchValues(url = CSV_URL) {
  const r = await fetch(url, { redirect: 'follow' });
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

const contacts = fs.existsSync(CONTACTS_PATH) ? JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8')) : {};

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

// write a git-diff-friendly JSON array: one record per line
const writeArray = (file, rows) =>
  fs.writeFileSync(file, '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');

// --- source 1: Festhome "Future Festivals" ---
async function buildFesthome() {
  const items = parseRows(await fetchValues(CSV_URL));
  console.log(`Festhome: parsed ${items.length} festivals`);
  const out = [];
  for (const f of items) {
    const { addr, ...rec } = f;
    const geo = await geocode(addr, rec.country);
    rec.lat = geo.lat; rec.lon = geo.lon; rec.prec = geo.prec;
    out.push(Object.fromEntries(FIELD_ORDER.map((k) => [k, rec[k]])));
  }
  writeArray(OUT_PATH, out);
  const miss = out.filter((r) => r.lat == null).length;
  console.log(`  wrote ${out.length} -> ${path.relative(ROOT, OUT_PATH)} (missing coords: ${miss})`);
  return out.length;
}

// --- source 2: FilmFreeway (directory tab + browser-scraped dates) ---
async function buildFilmFreeway() {
  const items = parseFFRows(await fetchValues(CSV_URL_FF));
  const dates = fs.existsSync(FF_DATES_PATH) ? JSON.parse(fs.readFileSync(FF_DATES_PATH, 'utf8')) : {};
  const nDates = Object.keys(dates).length;
  console.log(`FilmFreeway: parsed ${items.length} festivals; ${nDates} have scraped dates`);

  const out = [];
  for (const f of items) {
    const { addr, ...rec } = f;
    const geo = await geocode(addr, rec.country);
    rec.lat = geo.lat; rec.lon = geo.lon; rec.prec = geo.prec;

    const d = dates[rec.slug] || null;            // dates keyed by slug
    rec.start = (d && d.eventStart) || null;      // festival date = PRIMARY
    rec.end = (d && d.eventEnd) || null;
    rec.deadline = (d && d.finalDeadline) || null;
    rec.opens = (d && d.opens) || null;
    rec.hasDates = !!rec.start;

    const warn = [];
    if (rec.start && rec.end && rec.end < rec.start) warn.push('end before start');
    rec.warn = warn;
    rec.inactive = warn.length > 0;
    rec.src = 'ff';
    out.push(Object.fromEntries(FF_FIELD_ORDER.map((k) => [k, rec[k]])));
  }
  writeArray(OUT_FF_PATH, out);
  const withDates = out.filter((r) => r.hasDates).length;
  const miss = out.filter((r) => r.lat == null).length;
  console.log(`  wrote ${out.length} -> ${path.relative(ROOT, OUT_FF_PATH)} (with festival dates: ${withDates}, missing coords: ${miss})`);
  return out.length;
}

// --- source 3: Shortfilmdepot (public JSON API) ---
async function fetchSFD(pathname, init) {
  const r = await fetch(SFD_API + pathname, {
    ...init,
    headers: { accept: 'application/json', culture: 'en', 'user-agent': UA, ...(init && init.headers) },
  });
  if (!r.ok) throw new Error(`shortfilmdepot ${pathname} HTTP ${r.status}`);
  return r.json();
}

async function buildShortfilmdepot() {
  const countries = await fetchSFD('/pays/dico');
  const countryById = Object.fromEntries(countries.map((p) => [p.Id, p.Libelle]));

  const list = await fetchSFD(`/festivals/filter/0/${SFD_TAKE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      skip: 0,
      take: SFD_TAKE,
      filter: {
        Tri: SFD_SORT_LEGACY, Classement: null, GlobalSearch: null, IdsPkExclude: [], IdsPk: [],
        TriV2: SFD_SORT, IdCompte: null, SearchEventId: null, IdPays: null,
        IsCampagneOuverte: null, IsPayant: null, DeadLineComparer: null, DeadLine: null,
        Edition: null, EditionComparer: null, IdsCategorie: [], IdsGenre: [],
        IdsThematique: [], PecRealisateurs: [], PrixRange: null,
      },
    }),
  });

  const items = parseSFDRows(list, countryById);
  console.log(`Shortfilmdepot: parsed ${items.length} festivals`);

  const out = [];
  for (const f of items) {
    const { addr, ...rec } = f;
    const geo = await geocode(addr, rec.country);
    rec.lat = geo.lat; rec.lon = geo.lon; rec.prec = geo.prec;
    const withContacts = applyContacts(rec, contacts);
    out.push(Object.fromEntries(SFD_FIELD_ORDER.map((k) => [k, withContacts[k]])));
  }
  writeArray(OUT_SFD_PATH, out);
  const withDeadline = out.filter((r) => r.deadline).length;
  const miss = out.filter((r) => r.lat == null).length;
  console.log(`  wrote ${out.length} -> ${path.relative(ROOT, OUT_SFD_PATH)} (with deadline: ${withDeadline}, missing coords: ${miss})`);
  return out.length;
}

// --- source 4: Festagent (server-rendered list pages) ---
// Every field the map needs is on /en/festivals?page=N (30 rows a page, ~51 pages),
// so the ~1,500 detail pages are never fetched. Pages are walked until one comes
// back without rows; MAX is a runaway guard, far above the real page count.
const FA_BASE = process.env.FA_BASE || 'https://festagent.com';
const FA_MAX_PAGES = 200;

async function buildFestagent() {
  const pages = [];
  for (let p = 1; p <= FA_MAX_PAGES; p++) {
    const r = await fetch(`${FA_BASE}/en/festivals?page=${p}`, {
      headers: { accept: 'text/html', 'user-agent': UA },
    });
    if (!r.ok) throw new Error(`festagent page ${p} HTTP ${r.status}`);
    const html = await r.text();
    if (!html.includes('class="title-link"')) break; // past the last page
    pages.push(html);
    await sleep(1000); // one list page a second
  }

  const items = parseFARows(pages);
  // zero rows means the markup changed, not that the catalogue emptied — fail loudly
  // rather than deploy an empty layer
  if (!items.length) throw new Error(`festagent: parsed 0 festivals from ${pages.length} pages — markup changed?`);
  console.log(`Festagent: parsed ${items.length} festivals from ${pages.length} pages`);

  const out = [];
  for (const f of items) {
    const { addr, ...rec } = f;
    const geo = await geocode(addr, rec.country);
    rec.lat = geo.lat; rec.lon = geo.lon; rec.prec = geo.prec;
    const withContacts = applyContacts(rec, contacts);
    out.push(Object.fromEntries(FA_FIELD_ORDER.map((k) => [k, withContacts[k]])));
  }
  writeArray(OUT_FA_PATH, out);
  const withDeadline = out.filter((r) => r.deadline).length;
  const miss = out.filter((r) => r.lat == null).length;
  console.log(`  wrote ${out.length} -> ${path.relative(ROOT, OUT_FA_PATH)} (with deadline: ${withDeadline}, missing coords: ${miss})`);
  return out.length;
}

// --- source 5: Movibeta (Inertia.js data-page JSON) ---
// /festivals?page=N embeds its props as JSON (30 rows a page); every page reports
// last_page. Raw rows carry payment and webhook fields: they stay in this function's
// memory and only parseMBRows' whitelisted fields are written.
const MB_BASE = process.env.MB_BASE || 'https://www.movibeta.com';
const MB_MAX_PAGES = 200; // runaway guard if last_page ever misreports

async function buildMovibeta() {
  const rows = [];
  const states = {};
  let last = 1;
  for (let p = 1; p <= last && p <= MB_MAX_PAGES; p++) {
    const r = await fetch(`${MB_BASE}/festivals?page=${p}`, {
      headers: { accept: 'text/html', 'user-agent': UA },
    });
    if (!r.ok) throw new Error(`movibeta page ${p} HTTP ${r.status}`);
    const page = parseMBPage(await r.text());
    rows.push(...page.rows);
    Object.assign(states, page.states);
    last = page.lastPage;
    await sleep(1000); // one list page a second
  }

  const items = parseMBRows(rows, states);
  if (!items.length) throw new Error(`movibeta: parsed 0 festivals from ${last} pages — markup changed?`);
  console.log(`Movibeta: parsed ${items.length} festivals from ${last} pages`);

  const out = [];
  for (const f of items) {
    const { addr, ...rec } = f;
    const geo = await geocode(addr, rec.country);
    rec.lat = geo.lat; rec.lon = geo.lon; rec.prec = geo.prec;
    const withContacts = applyContacts(rec, contacts);
    out.push(Object.fromEntries(MB_FIELD_ORDER.map((k) => [k, withContacts[k]])));
  }
  writeArray(OUT_MB_PATH, out);
  const withDates = out.filter((r) => r.hasDates).length;
  const miss = out.filter((r) => r.lat == null).length;
  console.log(`  wrote ${out.length} -> ${path.relative(ROOT, OUT_MB_PATH)} (with festival dates: ${withDates}, missing coords: ${miss})`);
  return out.length;
}

async function main() {
  const fhCount = await buildFesthome();
  const ffCount = await buildFilmFreeway();
  const sfdCount = await buildShortfilmdepot();
  const faCount = await buildFestagent();
  const mbCount = await buildMovibeta();

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0));
  // sidecar: when this data was generated, so the map can show "updated Nh ago"
  // and the refresh button can detect when a fresh build has landed. Not tracked
  // in git (changes every run) — it's regenerated + deployed on each ingest.
  fs.writeFileSync(META_PATH, JSON.stringify({ generated: new Date().toISOString(), count: fhCount, countFF: ffCount, countSFD: sfdCount, countFA: faCount, countMB: mbCount }) + '\n');
  console.log(`done (geocode calls this run: ${geocodeCalls})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
