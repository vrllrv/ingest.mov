// Keyword panel collector: Keywordtool.io search volume for the markets and keyword
// sets in keywords/seeds.json -> ingest/keywords.json (committed, like contacts.json),
// then public/fest-map/keypanel/data.json for the panel.
//
// The daily quota (Starter: 50 requests, resetting at about 14:00 UTC) is one pool
// SHARED with the Keywordtool web app and MCP. Every run reads /v2/quota first and never
// takes the remaining count below --floor; if the quota can't be read, it spends nothing.
// The 15-a-minute rate limit is account-wide too, so someone else's calls can trip it
// mid-run: on a limit, the run waits a minute and re-reads the daily quota, and carries
// on only as far as the floor still allows (at most MAX_LIMIT_WAITS times a run).
// Search volume is a monthly Google Ads average, so asking again within a month returns
// the same numbers: a job is due only when never fetched, older than maxAgeDays, or
// when seeds.json added keywords to it. Nothing due -> no API call at all.
//
//   npm run keywords                        due jobs within budget and floor (seeds.json "collector")
//   npm run keywords -- --dry-run           print the queue; no network
//   npm run keywords -- --build-only        rebuild the panel data; no network
//   npm run keywords -- --budget 2 --floor 30
//   npm run keywords -- --only vol:es       just these job ids (comma list), if due
//   npm run keywords -- --no-quota-check    spend --budget without reading the quota
//
// Needs KEYWORDTOOL_API_KEY (a GitHub secret in CI). The key is never written or logged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planJobs, dueQueue, spendable, requestFor, parseVolume, parseSuggestions, parseQuota,
  seedProblems, buildPanel, serializeCache, serializePanel,
} from './keywords-parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SEEDS_PATH = path.join(HERE, 'keywords/seeds.json');
const CACHE_PATH = path.join(HERE, 'keywords.json');
const PANEL_PATH = path.join(ROOT, 'public/fest-map/keypanel/data.json');
const DATA = {
  festhome: path.join(ROOT, 'public/fest-map/data.json'),
  ff: path.join(ROOT, 'public/fest-map/data-ff.json'),
  sfd: path.join(ROOT, 'public/fest-map/data-sfd.json'),
  fa: path.join(ROOT, 'public/fest-map/data-fa.json'),
  mb: path.join(ROOT, 'public/fest-map/data-mb.json'),
};

const API = process.env.KEYWORDTOOL_API || 'https://api.keywordtool.io';
const KEY = process.env.KEYWORDTOOL_API_KEY || '';
const UA = 'ingest.mov-festmap/1.0 (+https://ingest.mov)';
const GAP_MS = 5000; // the API allows 15 requests a minute
// How long to wait out a per-minute limit; overridable so the stub tests don't wait.
const LIMIT_WAIT_MS = Number(process.env.KEYWORDTOOL_LIMIT_WAIT_MS) || 65000;
const MAX_LIMIT_WAITS = 3;

// --- options ---
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const seeds = readJson(SEEDS_PATH);
const cfg = seeds.collector || {};
const BUDGET = Number(opt('budget', cfg.budget ?? 20));
const FLOOR = Number(opt('floor', cfg.floor ?? 30));
const MAX_AGE_DAYS = Number(cfg.maxAgeDays ?? 28);
const ONLY = opt('only', null) ? new Set(String(opt('only')).split(',')) : null;
const DRY = argv.includes('--dry-run');
const BUILD_ONLY = argv.includes('--build-only');
const NO_QUOTA = argv.includes('--no-quota-check');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const redact = (s) => (KEY ? String(s).split(KEY).join('***') : String(s));

// --- cache ---
const cache = fs.existsSync(CACHE_PATH) ? readJson(CACHE_PATH) : { jobs: {}, runs: [] };
// rows the API returned without data (volume null) are stored as null
for (const job of Object.values(cache.jobs)) {
  for (const [k, x] of Object.entries(job.kw || {})) if (x && x.v == null) job.kw[k] = null;
}
let run = null; // the run in progress, so an interrupted run is still logged
function saveCache() {
  cache.runs = cache.runs.slice(-200);
  fs.writeFileSync(CACHE_PATH + '.tmp', serializeCache(cache));
  fs.renameSync(CACHE_PATH + '.tmp', CACHE_PATH);
}

// --- HTTP ---
let lastCall = 0;
async function call(method, pathname, body) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = method === 'GET' ? `${API}${pathname}?apikey=${encodeURIComponent(KEY)}` : `${API}${pathname}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(url, {
      method,
      headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify({ apikey: KEY, ...body }) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* reported below */ }
    return { status: r.status, ok: r.ok, json, text };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message };
  } finally {
    clearTimeout(timer);
  }
}
// Codes 7 and 9 are "limit of searches" / "daily limit". Which limit it was isn't
// trusted from the text: afterLimit() re-reads the daily quota to decide.
const limitHit = (res) => /"code"\s*:\s*"?(7|9)\b/.test(res.text) || /daily limit|limit of searches/i.test(res.text);

async function readQuota() {
  const res = await call('GET', '/v2/quota');
  const q = res.ok && res.json ? parseQuota(res.json) : null;
  if (!q) log(`quota: couldn't read it (HTTP ${res.status}): ${redact(res.text).slice(0, 300)}`);
  return q;
}

// After a limit: wait out the minute, re-read the daily quota, and return how many of
// the `want` remaining jobs the floor still allows (0 = stop). A daily limit reads as
// at or below the floor, so it stops; a per-minute one carries on.
let limitWaits = 0;
async function afterLimit(want) {
  if (limitWaits >= MAX_LIMIT_WAITS) return 0;
  limitWaits++;
  log(`  waiting ${Math.round(LIMIT_WAIT_MS / 1000)}s, then re-reading the daily quota`);
  await sleep(LIMIT_WAIT_MS);
  if (NO_QUOTA) return want;
  const q = await readQuota();
  if (!q) return 0;
  const allowed = spendable(want, FLOOR, q.remaining);
  log(`  quota: ${q.remaining} left; floor ${FLOOR} -> ${allowed ? `continuing with ${allowed}` : 'stopping'}`);
  return allowed;
}

// --- map rows for the panel ---
function catalogue() {
  const rows = [];
  for (const [src, p] of Object.entries(DATA)) {
    if (!fs.existsSync(p)) continue;
    for (const r of readJson(p)) rows.push({ ...r, src: r.src || src });
  }
  return rows;
}
function build() {
  const now = Date.now();
  const panel = buildPanel({ seeds, cache, rows: catalogue(), today: new Date(now).toISOString().slice(0, 10), now });
  fs.mkdirSync(path.dirname(PANEL_PATH), { recursive: true });
  fs.writeFileSync(PANEL_PATH, serializePanel(panel));
  const measured = panel.markets.filter((m) => m.fetchedAt).length;
  log(`panel: ${panel.markets.length} markets (${measured} measured), ${panel.candidates.length} discovery candidates, `
    + `${panel.festivals.groups} festivals -> ${path.relative(ROOT, PANEL_PATH)}`);
}

async function main() {
  for (const p of seedProblems(seeds)) log(`seeds: ${p}`);
  const jobs = planJobs(seeds);
  const markets = Object.fromEntries(seeds.markets.map((m) => [m.id, m]));
  let queue = dueQueue(jobs, cache, Date.now(), MAX_AGE_DAYS);
  if (ONLY) queue = queue.filter((d) => ONLY.has(d.job.id));

  if (BUILD_ONLY) { build(); return; }

  if (DRY) {
    const vol = jobs.filter((j) => j.kind === 'volume');
    log(`${jobs.length} jobs: ${vol.length} volume (${Math.max(...vol.map((j) => j.keywords.length))} keywords max), ${jobs.length - vol.length} discovery`);
    for (const { job, why } of queue) {
      log(`  ${why.padEnd(8)} t${job.tier} ${job.id}${job.kind === 'volume' ? ` (${job.keywords.length} keywords)` : ''}`);
    }
    log(`${queue.length} due -> ~${Math.ceil(queue.length / Math.max(1, BUDGET))} day(s) at ${BUDGET} a day`);
    return;
  }

  if (!queue.length) { log('nothing due — no API call made'); return; }
  if (!KEY) {
    // not an error: the daily workflow shouldn't go red before the secret is added
    const msg = `KEYWORDTOOL_API_KEY is not set — ${queue.length} job(s) due, nothing collected`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
    return;
  }

  run = { at: new Date().toISOString(), budget: BUDGET, floor: FLOOR, before: null, after: null, spent: 0, jobs: [], errors: [] };
  let n = BUDGET;
  if (!NO_QUOTA) {
    const q = await readQuota();
    run.before = q ? q.remaining : null;
    n = spendable(BUDGET, FLOOR, q ? q.remaining : NaN);
    if (!q) { process.exitCode = 2; log('spending nothing: the quota is shared, so it must be readable (try --no-quota-check --budget 1 locally)'); }
    else log(`quota: ${q.remaining} left${q.limit != null ? ` of ${q.limit}` : ''}; floor ${FLOOR}, budget ${BUDGET} -> ${n} request(s)`);
  }
  log(`${queue.length} job(s) due; running ${Math.min(n, queue.length)}`);
  if (n <= 0) return; // nothing recorded, so keywords.json doesn't change

  const todo = queue.slice(0, n);
  for (let i = 0; i < todo.length; i++) {
    const { job, why } = todo[i];
    const { path: p, body } = requestFor(job, markets[job.market], { network: cfg.network });
    let res = await call('POST', p, body);
    if (res.status === 429) { log(`  429 — waiting ${Math.round(LIMIT_WAIT_MS / 1000)}s`); await sleep(LIMIT_WAIT_MS); res = await call('POST', p, body); }
    run.spent++;
    if (limitHit(res)) {
      log(`  ${job.id}: limit reached: ${redact(res.text).slice(0, 300)}`);
      const allowed = await afterLimit(todo.length - i);
      if (allowed > 0) {
        todo.length = i + allowed; // the fresh quota may allow fewer jobs than planned
        res = await call('POST', p, body);
        run.spent++;
      }
      if (allowed <= 0 || limitHit(res)) {
        run.errors.push(`${job.id}: quota limit reached`);
        log(`  ${job.id}: quota limit reached — stopping`);
        break;
      }
    }
    if (!res.ok || !res.json) {
      run.errors.push(`${job.id}: HTTP ${res.status}`);
      log(`  ${job.id}: HTTP ${res.status} ${redact(res.text).slice(0, 300)}`);
      continue;
    }
    try {
      const parsed = job.kind === 'volume'
        ? parseVolume(res.json, job.keywords)
        : parseSuggestions(res.json, cfg.discoveryMinVolume ?? 10);
      cache.jobs[job.id] = { at: new Date().toISOString(), ...parsed };
      run.jobs.push(job.id);
      const got = Object.values(parsed.kw).filter(Boolean);
      log(`  ${job.id} (${why}): ${got.length} keyword(s) with data, total volume ${got.reduce((s, x) => s + (x.v || 0), 0)}`
        + (parsed.dropped ? `, ${parsed.dropped} below the discovery minimum` : ''));
      saveCache();
    } catch (e) {
      run.errors.push(`${job.id}: ${e.message}`);
      log(`  ${job.id}: unparseable (${e.message}): ${redact(res.text).slice(0, 300)}`);
    }
  }

  if (!NO_QUOTA && run.spent) { const q = await readQuota(); run.after = q ? q.remaining : null; }
  const done = run;
  cache.runs.push(done);
  run = null; // logged now, so the SIGINT handler mustn't push it again
  saveCache();
  log(`spent ${done.spent}; ${done.jobs.length} job(s) stored${done.errors.length ? `; ${done.errors.length} error(s)` : ''}`
    + (done.after != null ? `; ${done.after} left` : ''));
  build();
}

process.on('SIGINT', () => {
  if (run && run.spent) { run.errors.push('interrupted'); cache.runs.push(run); }
  saveCache();
  console.log('\nstopped — progress saved; run again to resume');
  process.exit(130);
});
main().catch((e) => { console.error(redact(e.stack || e)); process.exit(1); });
