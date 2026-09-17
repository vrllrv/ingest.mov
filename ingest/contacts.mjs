// Contacts: email / website / instagram / facebook for the Shortfilmdepot, Festagent
// and Movibeta catalogues -> ingest/contacts.json (committed, like geocache.json).
//
// Slow on purpose. One request a second per platform (the three run side by side),
// then each festival's own homepage for Instagram, a few hosts at a time, robots.txt
// respected. Progress is saved as it goes: stop it any time and run it again to
// resume. The ingest never scrapes — it only merges contacts.json.
//
//   npm run contacts                          everything due: never fetched, or older than --max-age-days
//   npm run contacts -- --only-new            only festivals never fetched
//   npm run contacts -- --budget 150          at most 150 platform requests (CI)
//   npm run contacts -- --sources fa,mb       a subset of catalogues
//   npm run contacts -- --no-websites         skip the homepage pass
//   npm run contacts -- --max-age-days 180    refetch entries older than this
//
// Reads the catalogue from public/fest-map/data-{sfd,fa,mb}.json (run the ingest
// first), and patches the contact fields of those files in place when done.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInertiaProps } from './parse.mjs';
import {
  parseSFDFiche, parseFADetail, parseMBDescription, parseSiteSocials, normUrl,
  buildMatchIndex, lookupMatch, combineContacts, applyContacts, renormLayer, vetSiteLayer,
} from './contacts-parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_PATH = path.join(HERE, 'contacts.json');
const DATA = {
  sfd: path.join(ROOT, 'public/fest-map/data-sfd.json'),
  fa: path.join(ROOT, 'public/fest-map/data-fa.json'),
  mb: path.join(ROOT, 'public/fest-map/data-mb.json'),
};
const FESTHOME_DATA = path.join(ROOT, 'public/fest-map/data.json');

const UA = 'ingest.mov-festmap/1.0 (+https://ingest.mov)';
const SITE_UA = 'Mozilla/5.0 (compatible; ingest.mov-festmap/1.0; +https://ingest.mov)';
const SFD_API = process.env.SFD_API || 'https://apiv3-user.shortfilmdepot.com';
const FA_BASE = process.env.FA_BASE || 'https://festagent.com';
const MB_BASE = process.env.MB_BASE || 'https://www.movibeta.com';

// --- options ---
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
};
const SOURCES = String(opt('sources', 'sfd,fa,mb')).split(',').filter((s) => DATA[s] && fs.existsSync(DATA[s]));
const ONLY_NEW = argv.includes('--only-new');
const BUDGET = Number(opt('budget', Infinity));
const MAX_AGE_DAYS = Number(opt('max-age-days', 180));
const WEBSITES = !argv.includes('--no-websites');
const SITE_WORKERS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const due = (checked) => !checked || (!ONLY_NEW && (Date.now() - Date.parse(checked)) / 864e5 > MAX_AGE_DAYS);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- cache: one festival per line, keys sorted, so diffs stay readable ---
const cache = fs.existsSync(CACHE_PATH) ? readJson(CACHE_PATH) : {};
function saveCache() {
  const body = '{\n' + Object.keys(cache).sort().map((k) => JSON.stringify(k) + ': ' + JSON.stringify(cache[k])).join(',\n') + '\n}\n';
  fs.writeFileSync(CACHE_PATH + '.tmp', body);
  fs.renameSync(CACHE_PATH + '.tmp', CACHE_PATH);
}
// layers: platform (the catalogue's own page), site (the festival's homepage),
// match (Movibeta only: the same festival in another catalogue). The top-level
// fields are recombined from them in that priority order on every write.
function setEntry(id, patch) {
  const e = { ...(cache[id] || {}), ...patch };
  const c = combineContacts([['platform', e.platform], ['website', e.site], ['match', e.match]]);
  cache[id] = {
    email: c.email, emails: c.emails.length ? c.emails : undefined, website: c.website,
    instagram: c.instagram, facebook: c.facebook, via: c.via,
    platform: e.platform, checked: e.checked, site: e.site, siteChecked: e.siteChecked, match: e.match || undefined,
  };
}
let unsaved = 0;
const touched = () => { if (++unsaved >= 25) { saveCache(); unsaved = 0; } };
process.on('SIGINT', () => { saveCache(); console.log('\nstopped — progress saved; run again to resume'); process.exit(130); });

// --- HTTP: pacing per host, backoff on 429/503, capped bodies ---
const lastStart = new Map();
async function paced(host, gapMs) {
  const wait = (lastStart.get(host) || 0) + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastStart.set(host, Date.now());
}
async function readText(r, maxBytes) {
  if (!r.body || !Number.isFinite(maxBytes)) return r.text();
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length;
    if (n >= maxBytes) { await reader.cancel(); break; }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
// -> { ok, status, text, url, type } | { retryLater, status } | { error }
async function get(url, { method = 'GET', body, headers, gapMs = 1000, timeoutMs = 30000, maxBytes = Infinity, backoff = [30000, 60000, 120000], retries = 2 } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0, errors = 0; ; attempt++) {
    await paced(host, gapMs);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method, body, headers, redirect: 'follow', signal: ctl.signal });
      if ((r.status === 429 || r.status === 503) && backoff.length) {
        await r.body?.cancel();
        const b = backoff[attempt];
        if (b == null) return { retryLater: true, status: r.status };
        log(`  ${host} HTTP ${r.status} — pausing ${b / 1000}s`);
        await sleep(b);
        continue;
      }
      return { ok: r.ok, status: r.status, text: await readText(r, maxBytes), url: r.url, type: r.headers.get('content-type') || '' };
    } catch (e) {
      if (++errors <= retries) { await sleep(5000); continue; }
      return { error: e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- catalogue ---
const records = Object.fromEntries(SOURCES.map((s) => [s, readJson(DATA[s])]));
const openFirst = (list) => [...list].sort((a, b) => (a.status === 'Closed' || !a.status) - (b.status === 'Closed' || !b.status));
let spent = 0; // platform requests this run, against --budget
const stats = { retryLater: 0, failed: 0, gone: 0, platform: 0, sites: 0, siteBlocked: 0 };

// Shortfilmdepot's fiche endpoint wants the numeric Id; the map only has the slug.
// Same list call as the ingest — skip/take must be in the BODY.
async function sfdIdsBySlug() {
  spent++;
  const res = await get(`${SFD_API}/festivals/filter/0/2000`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', culture: 'en', 'user-agent': UA },
    body: JSON.stringify({ skip: 0, take: 2000, filter: { Tri: [], TriV2: [], IdsPkExclude: [], IdsPk: [], IdsCategorie: [], IdsGenre: [], IdsThematique: [], PecRealisateurs: [] } }),
  });
  if (!res.ok) throw new Error(`shortfilmdepot list: ${res.status || res.error}`);
  return Object.fromEntries(JSON.parse(res.text).map((f) => [f.ShortName, f.Id]));
}

const PLATFORM = {
  sfd: {
    url: (rec, ctx) => ctx.ids[rec.slug] != null && `${SFD_API}/festivals/${ctx.ids[rec.slug]}/fiche/en`,
    headers: { accept: 'application/json', culture: 'en', 'user-agent': UA },
    parse: (text) => parseSFDFiche(JSON.parse(text)),
  },
  fa: {
    url: (rec) => `${FA_BASE}/en/festivals/${rec.slug}`,
    headers: { accept: 'text/html', 'user-agent': UA },
    parse: (text) => parseFADetail(text),
  },
  mb: {
    url: (rec) => `${MB_BASE}/festivals/${rec.slug}`,
    headers: { accept: 'text/html', 'user-agent': UA },
    // only the two free-text fields leave this function: the project also holds
    // email_paypal and webhook tokens
    parse: (text) => {
      const { project } = readInertiaProps(text);
      if (!project) throw new Error('no project in data-page');
      return parseMBDescription({ descripcion: project.descripcion, textoPortada: project.textoPortada });
    },
  },
};

async function platformPass(src) {
  const todo = openFirst(records[src]).filter((r) => !(cache[r.id] && cache[r.id].checked && !due(cache[r.id].checked)));
  if (!todo.length) { log(`[${src}] nothing due`); return; }
  log(`[${src}] ${todo.length} festivals to fetch`);
  const p = PLATFORM[src];
  const ctx = src === 'sfd' ? { ids: await sfdIdsBySlug() } : {};
  let n = 0;
  for (const rec of todo) {
    if (spent >= BUDGET) { log(`[${src}] budget of ${BUDGET} requests reached`); break; }
    const url = p.url(rec, ctx);
    if (!url) { setEntry(rec.id, { platform: { gone: true }, checked: today() }); stats.gone++; touched(); continue; }
    spent++;
    const res = await get(url, { headers: p.headers });
    if (res.status === 404 || res.status === 410) {
      setEntry(rec.id, { platform: { gone: true }, checked: today() }); stats.gone++;
    } else if (res.ok) {
      try {
        setEntry(rec.id, { platform: p.parse(res.text), checked: today() }); stats.platform++;
      } catch (e) {
        stats.failed++; log(`  [${src}] ${rec.id}: unparseable (${e.message}) — will retry next run`);
      }
    } else if (res.retryLater) {
      stats.retryLater++; // left uncached: the next run tries again
    } else {
      stats.failed++; log(`  [${src}] ${rec.id}: ${res.status || res.error} — will retry next run`);
    }
    touched();
    if (++n % 50 === 0 || n === todo.length) {
      const got = (f) => records[src].filter((r) => cache[r.id] && cache[r.id][f]).length;
      log(`[${src}] ${n}/${todo.length} — email ${got('email')}, website ${got('website')}, instagram ${got('instagram')}`);
    }
  }
}

// --- homepages ---
const robotsCache = new Map();
// true when the rules that apply to us (our own group, else "*") disallow everything
function robotsBlocksAll(txt) {
  const groups = [];
  let cur = null, inAgents = false;
  for (const line of String(txt).split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!inAgents) { cur = { agents: [], disallowAll: false }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); inAgents = true;
      continue;
    }
    inAgents = false;
    if (cur && key === 'disallow' && val === '/') cur.disallowAll = true;
  }
  const ours = groups.filter((g) => g.agents.some((a) => a.length > 2 && a !== '*' && 'ingest.mov-festmap'.includes(a)));
  return (ours.length ? ours : groups.filter((g) => g.agents.includes('*'))).some((g) => g.disallowAll);
}
async function allowedByRobots(origin) {
  if (!robotsCache.has(origin)) {
    const res = await get(origin + '/robots.txt', { headers: { 'user-agent': SITE_UA }, gapMs: 0, timeoutMs: 8000, maxBytes: 200000, backoff: [], retries: 0 });
    robotsCache.set(origin, !(res.ok && !/<html/i.test(res.text.slice(0, 500)) && robotsBlocksAll(res.text)));
  }
  return robotsCache.get(origin);
}

async function sitePass() {
  const byUrl = new Map(); // one homepage can serve several festivals
  for (const src of SOURCES) {
    for (const rec of records[src]) {
      const e = cache[rec.id];
      if (!e || !e.checked || (e.platform && e.platform.gone)) continue;
      if (e.instagram && e.email) continue;
      if (!due(e.siteChecked)) continue;
      const site = normUrl(e.website || rec.website);
      if (!site) continue;
      if (!byUrl.has(site)) byUrl.set(site, []);
      byUrl.get(site).push(rec.id);
    }
  }
  let urls = [...byUrl.keys()];
  if (Number.isFinite(BUDGET)) urls = urls.slice(0, BUDGET);
  if (!urls.length) { log('[sites] nothing due'); return; }
  log(`[sites] ${urls.length} homepages for ${urls.reduce((n, u) => n + byUrl.get(u).length, 0)} festivals`);

  // hosts in parallel, each host's pages one at a time
  const byHost = new Map();
  for (const u of urls) { const h = new URL(u).host; if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(u); }
  const hosts = [...byHost.keys()];
  let n = 0;
  const worker = async () => {
    for (let h = hosts.shift(); h; h = hosts.shift()) {
      for (const u of byHost.get(h)) {
        let site;
        if (!(await allowedByRobots(new URL(u).origin))) {
          site = { error: 'robots' }; stats.siteBlocked++;
        } else {
          const res = await get(u, { headers: { 'user-agent': SITE_UA, accept: 'text/html,application/xhtml+xml' }, gapMs: 1000, timeoutMs: 12000, maxBytes: 1.5e6, backoff: [], retries: 0 });
          if (res.ok && /html/i.test(res.type)) { site = parseSiteSocials(res.text, [u, res.url]); stats.sites++; }
          else site = { error: String(res.status || res.error || res.type || 'not html') };
        }
        // dead or blocked sites are cached too, so they're not retried until --max-age-days
        for (const id of byUrl.get(u)) { setEntry(id, { site, siteChecked: today() }); touched(); }
        if (++n % 50 === 0 || n === urls.length) log(`[sites] ${n}/${urls.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: SITE_WORKERS }, worker));
}

// --- review every stored layer under the current rules (no network) ---
// Values are re-normalised, and homepage accounts are re-vetted against the festival
// they were found for: an organiser's, venue's or spam account moves to site.rejected.
// Rules improve over time; stored layers follow without refetching anything.
function reviewLayers() {
  const byId = {};
  for (const src of Object.keys(DATA)) if (fs.existsSync(DATA[src])) for (const r of readJson(DATA[src])) byId[r.id] = r;
  let rejected = 0;
  for (const [id, e] of Object.entries(cache)) {
    const rec = byId[id] || {};
    const platform = renormLayer(e.platform);
    const site = vetSiteLayer(e.site, {
      name: rec.name, website: (platform && platform.website) || rec.website, emails: (platform && platform.emails) || [],
    });
    if (site && site.rejected) rejected += Object.keys(site.rejected).length;
    setEntry(id, { platform, site });
  }
  log(`[review] ${rejected} homepage accounts set aside as not the festival's own`);
}

// --- Movibeta borrows from the same festival elsewhere (no network) ---
function matchPass() {
  if (!records.mb) return;
  const own = (id) => { const e = cache[id]; return e ? combineContacts([['platform', e.platform], ['website', e.site]]) : {}; };
  const candidates = [
    ...(fs.existsSync(FESTHOME_DATA) ? readJson(FESTHOME_DATA) : []).map((r) => ({
      id: 'festhome:' + r.id, src: 'festhome', name: r.name, country: r.country,
      email: r.email, website: r.website, instagram: r.instagram, facebook: r.facebook,
    })),
    ...['sfd', 'fa'].flatMap((s) => (fs.existsSync(DATA[s]) ? readJson(DATA[s]) : []).map((r) => ({
      id: r.id, src: s, name: r.name, country: r.country, ...pick(own(r.id)),
    }))),
  ];
  const index = buildMatchIndex(candidates);
  let hits = 0;
  for (const rec of records.mb) {
    const match = lookupMatch(index, rec.name, rec.country);
    const had = cache[rec.id] && cache[rec.id].match;
    if (match) hits++;
    if (match || had) setEntry(rec.id, { match: match || undefined });
  }
  log(`[match] ${hits}/${records.mb.length} Movibeta festivals matched another catalogue`);
}
const pick = (c) => ({ email: c.email || null, website: c.website || null, instagram: c.instagram || null, facebook: c.facebook || null });

// --- write contacts back into the map data ---
function patchData() {
  for (const src of Object.keys(DATA)) {
    if (!fs.existsSync(DATA[src])) continue;
    const rows = readJson(DATA[src]).map((r) => applyContacts(r, cache));
    fs.writeFileSync(DATA[src], '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
  }
}

function summary() {
  for (const src of SOURCES) {
    const list = records[src];
    const c = (f) => list.filter((r) => cache[r.id] && cache[r.id][f]).length;
    const via = (f, v) => list.filter((r) => cache[r.id] && String((cache[r.id].via || {})[f] || '').startsWith(v)).length;
    log(`[${src}] ${list.length} festivals: email ${c('email')}, website ${c('website')}, instagram ${c('instagram')} (${via('instagram', 'website')} from homepages), facebook ${c('facebook')}`
      + (src === 'mb' ? ` — via name match: email ${via('email', 'match')}, website ${via('website', 'match')}, instagram ${via('instagram', 'match')}` : ''));
  }
  log(`requests: ${spent} platform, ${stats.sites} homepages (${stats.siteBlocked} blocked by robots.txt); gone ${stats.gone}, failed ${stats.failed}, retry later ${stats.retryLater}`);
}

async function main() {
  if (!SOURCES.length) throw new Error('no catalogue data — run `npm run ingest` first');
  log(`contacts: ${SOURCES.join(', ')}${ONLY_NEW ? ' (new only)' : ''}${Number.isFinite(BUDGET) ? `, budget ${BUDGET}` : ''}`);
  await Promise.all(SOURCES.map(platformPass));
  saveCache();
  if (WEBSITES) { await sitePass(); saveCache(); }
  reviewLayers();
  matchPass();
  saveCache();
  patchData();
  summary();
}

main().catch((e) => { saveCache(); console.error(e); process.exit(1); });
