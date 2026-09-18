// Keyword panel: pure helpers (no I/O).
//   seeds.json            -> job queue -> Keywordtool.io request bodies
//   API responses         -> compact cache entries (keywords.json)
//   cache + seeds + map   -> public/fest-map/keypanel/data.json
import { matchKey } from './contacts-parse.mjs';

const DAY = 864e5;
export const MAX_KEYWORDS_PER_REQUEST = 1000;

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// --- keywords ---
// Google Ads rejects keywords over 80 characters (API error 22) or 10 words (30), and
// some punctuation (38). Case and spacing don't change the volume, so they're folded.
export function cleanKeyword(raw) {
  const s = String(raw ?? '').normalize('NFC').toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s'&.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s'&.-]+|[\s'&.-]+$/g, '');
  if (!s || s.length > 80 || s.split(' ').length > 10) return null;
  return s;
}

// keyword -> { set, langs: Set }. A keyword may sit under several languages of one set
// ("exportar dcp" is Spanish and Portuguese); across sets the first set wins.
export function seedIndex(seeds) {
  const idx = new Map();
  for (const [set, def] of Object.entries(seeds.sets)) {
    for (const [lang, list] of Object.entries(def.kw)) {
      for (const raw of list) {
        const k = cleanKeyword(raw);
        if (!k) continue;
        if (!idx.has(k)) idx.set(k, { set, langs: new Set() });
        if (idx.get(k).set === set) idx.get(k).langs.add(lang);
      }
    }
  }
  return idx;
}

// cleaned keyword -> reason it isn't counted
export function flaggedIndex(seeds) {
  return Object.fromEntries(Object.entries(seeds.flagged || {}).map(([k, why]) => [cleanKeyword(k), why]).filter(([k]) => k));
}

// Human-readable warnings; nothing here stops a run.
export function seedProblems(seeds) {
  const out = [];
  const firstSet = new Map();
  for (const [set, def] of Object.entries(seeds.sets)) {
    for (const [lang, list] of Object.entries(def.kw)) {
      for (const raw of list) {
        const k = cleanKeyword(raw);
        if (!k) { out.push(`${set}/${lang}: "${raw}" is not a valid keyword (80 chars, 10 words) — skipped`); continue; }
        if (firstSet.has(k) && firstSet.get(k) !== set) out.push(`"${k}" is in both ${firstSet.get(k)} and ${set} — counted in ${firstSet.get(k)}`);
        else firstSet.set(k, set);
      }
    }
  }
  const ids = new Set();
  for (const m of seeds.markets) {
    if (ids.has(m.id)) out.push(`market id "${m.id}" is used twice`);
    ids.add(m.id);
  }
  for (const k of Object.keys(flaggedIndex(seeds))) {
    if (!firstSet.has(k)) out.push(`flagged "${k}" isn't in any set — nothing to flag`);
  }
  for (const d of seeds.discovery || []) {
    if (!ids.has(d.market)) out.push(`discovery "${d.head}": unknown market "${d.market}"`);
    if (!seeds.sets[d.set]) out.push(`discovery "${d.head}": unknown set "${d.set}"`);
    if (!cleanKeyword(d.head)) out.push(`discovery "${d.head}": not a valid keyword`);
  }
  return out;
}

// --- jobs ---
// One volume job per market, carrying every set's keywords in the market's languages
// plus the language-neutral "any" lists. metrics_language is left out, so the volume
// counts searches in every interface language (an English query typed in Spain counts).
// Discovery jobs are one suggestions call per (head, type).
export function planJobs(seeds) {
  const idx = seedIndex(seeds);
  const markets = Object.fromEntries(seeds.markets.map((m) => [m.id, m]));
  const jobs = [];
  seeds.markets.forEach((m, order) => {
    const langs = new Set(['any', ...m.kw]);
    const keywords = [...idx].filter(([, v]) => [...v.langs].some((l) => langs.has(l))).map(([k]) => k);
    for (let i = 0, part = 1; i < keywords.length; i += MAX_KEYWORDS_PER_REQUEST, part++) {
      jobs.push({
        id: part === 1 ? `vol:${m.id}` : `vol:${m.id}:${part}`, kind: 'volume', market: m.id, tier: m.tier, order,
        keywords: keywords.slice(i, i + MAX_KEYWORDS_PER_REQUEST),
      });
    }
  });
  (seeds.discovery || []).forEach((d, i) => {
    const m = markets[d.market];
    const head = cleanKeyword(d.head);
    if (!m || !head) return;
    for (const type of d.types) {
      jobs.push({
        id: `sug:${m.id}:${type}:${head}`, kind: 'discovery', market: m.id, tier: d.tier ?? m.tier, order: seeds.markets.length + i,
        head, lang: d.lang, cc: d.cc || m.cc || 'US', type, set: d.set,
      });
    }
  });
  return jobs;
}

// null when fresh; otherwise why it's due. A volume job whose keyword list grew is due
// again: the whole list is re-asked so every number in a market shares the same month.
export function dueReason(job, entry, now, maxAgeDays) {
  if (!entry || !entry.at) return 'new';
  if (job.kind === 'volume' && job.keywords.some((k) => !(k in (entry.kw || {})))) return 'keywords';
  if ((now - Date.parse(entry.at)) / DAY > maxAgeDays) return 'stale';
  return null;
}

// Due jobs in spending order: tier, then never-run before grown before stale, volume
// before discovery, then the order of seeds.json.
export function dueQueue(jobs, cache, now, maxAgeDays) {
  const rank = { new: 0, keywords: 1, stale: 2 };
  return jobs
    .map((job) => ({ job, why: dueReason(job, cache.jobs[job.id], now, maxAgeDays) }))
    .filter((x) => x.why)
    .sort((a, b) => a.job.tier - b.job.tier || rank[a.why] - rank[b.why]
      || (a.job.kind === b.job.kind ? 0 : a.job.kind === 'volume' ? -1 : 1) || a.job.order - b.job.order);
}

// Requests this run may spend. The daily quota is shared with the web app and the MCP,
// so an unreadable quota spends nothing.
export function spendable(budget, floor, remaining) {
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.min(budget, remaining - floor));
}

// { path, body } without the apikey (the caller adds it, and never logs it).
// The suggestions endpoint takes Google interface-language codes, which split
// Portuguese by country: bare "pt" is rejected ("The language \"pt\" is invalid",
// HTTP 404, live 2026-09-18; the error cost no quota) while "en" and "es" work.
// Volume requests send no language, so they were never affected.
const SUGGEST_LANG = { pt: { PT: 'pt-PT', default: 'pt-BR' } };
export function suggestLanguage(lang, cc) {
  const variants = SUGGEST_LANG[lang];
  return variants ? variants[cc] ?? variants.default : lang;
}

export function requestFor(job, market, { network = 'googlesearch' } = {}) {
  const loc = market && market.loc ? { metrics_location: [market.loc] } : {};
  if (job.kind === 'volume') {
    return {
      path: '/v2/search/volume/google',
      body: { keyword: job.keywords, ...loc, metrics_network: network, metrics_currency: 'USD', output: 'json' },
    };
  }
  return {
    path: '/v2/search/suggestions/google',
    body: {
      keyword: job.head, category: 'web', type: job.type, country: job.cc, language: suggestLanguage(job.lang, job.cc),
      metrics: true, ...loc, metrics_network: network, metrics_currency: 'USD', output: 'json',
    },
  };
}

// --- responses ---
// Results come keyed by keyword ({ string, volume, m1..m12, m1_month, m1_year, trend,
// cpc, cmp }; m1 is the latest month) or, for suggestions, grouped in arrays. Walk
// whatever nesting there is and keep the objects that carry a `string`.
function flattenResults(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return out;
  if (Array.isArray(node)) { for (const x of node) flattenResults(x, out, depth + 1); return out; }
  if (typeof node.string === 'string') { out.push(node); return out; }
  for (const v of Object.values(node)) flattenResults(v, out, depth + 1);
  return out;
}
const fold = (k) => k.normalize('NFD').replace(/\p{M}/gu, '');

// -> { v, cpc, cmp, t, s: [oldest .. newest] }
function metricsOf(r) {
  const s = [];
  for (let i = 12; i >= 1; i--) if (r[`m${i}`] !== undefined) s.push(numOrNull(r[`m${i}`]));
  return { v: numOrNull(r.volume), cpc: round2(numOrNull(r.cpc)), cmp: round2(numOrNull(r.cmp)), t: round2(numOrNull(r.trend)), s };
}
function monthOf(r) {
  const y = numOrNull(r.m1_year), m = numOrNull(r.m1_month);
  return y && m ? `${y}-${String(m).padStart(2, '0')}` : null;
}
function resultsOf(json) {
  const res = json && json.results;
  if (!res || typeof res !== 'object') throw new Error('response has no results');
  return flattenResults(res);
}

// Every asked keyword gets an entry: null when Google has no data for it (the API
// still returns a row, with volume and every month null), so a keyword without data
// doesn't make the job look incomplete forever and isn't counted as measured.
export function parseVolume(json, asked) {
  const exact = new Map(), folded = new Map();
  for (const r of resultsOf(json)) {
    const k = cleanKeyword(r.string);
    if (!k) continue;
    exact.set(k, r);
    if (!folded.has(fold(k))) folded.set(fold(k), r);
  }
  const kw = {};
  let last = null;
  for (const k of asked) {
    const r = exact.get(k) || folded.get(fold(k));
    const m = r ? metricsOf(r) : null;
    kw[k] = m && m.v != null ? m : null;
    if (r && !last) last = monthOf(r);
  }
  return { last, kw };
}

export function parseSuggestions(json, minVolume = 10) {
  const kw = {};
  const seen = new Set();
  let last = null, dropped = 0;
  for (const r of resultsOf(json)) {
    const k = cleanKeyword(r.string);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const m = metricsOf(r);
    if (!(m.v >= minVolume)) { dropped++; continue; }
    kw[k] = m;
    if (!last) last = monthOf(r);
  }
  return { last, dropped, kw };
}

// The quota endpoint's response isn't documented. Look for the daily window: an object
// under a day-like key with `remaining` (or `limit` and `used`); per-minute windows are
// ignored. Anything else -> null, and the collector spends nothing rather than guess.
export function parseQuota(json) {
  const found = [];
  const walk = (node, keys) => {
    if (!node || typeof node !== 'object' || keys.length > 5) return;
    const rem = numOrNull(node.remaining ?? node.left ?? node.available);
    const lim = numOrNull(node.limit ?? node.max ?? node.total);
    const used = numOrNull(node.used ?? node.usage ?? node.count);
    const remaining = rem ?? (lim != null && used != null ? lim - used : null);
    if (remaining != null) found.push({ keys, remaining, limit: lim, used });
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, [...keys, k.toLowerCase()]);
  };
  walk(json, []);
  const notMinute = found.filter((f) => !f.keys.some((k) => /min/.test(k)));
  const daily = notMinute.find((f) => f.keys.some((k) => /dai|day|24/.test(k)));
  const pick = daily || (notMinute.length === 1 ? notMinute[0] : null);
  return pick ? { remaining: pick.remaining, limit: pick.limit, used: pick.used } : null;
}

// --- the map's side ---
// Festhome's status is free text frozen at scrape time, so the deadline decides.
export function isOpen(r, today) {
  const st = r.status || '';
  if (st === 'Closed' || st === 'Soon' || /^Opens\b/.test(st)) return false;
  if (r.deadline) return r.deadline >= today;
  return st === 'Open'; // a rolling call
}

const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const blankStats = () => ({ unique: 0, upcoming: 0, open: 0, withEmail: 0, starts: Array(12).fill(0), deadlines: Array(12).fill(0) });

// One festival per exact normalised name + country across the five catalogues (the
// rule contacts matching uses), so a festival on several platforms counts once.
export function festivalStats(rows, today) {
  const yearOut = addDays(today, 365);
  const groups = new Map();
  for (const r of rows) {
    const k = matchKey(r.name, r.country) || `id:${r.src}:${r.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const total = blankStats();
  const byCountry = {};
  for (const g of groups.values()) {
    const country = g[0].country || null;
    const into = [total];
    if (country) into.push(byCountry[country] || (byCountry[country] = blankStats()));
    const upcoming = g.some((r) => r.start && r.start >= today && r.start < yearOut);
    const open = g.some((r) => isOpen(r, today));
    const withEmail = g.some((r) => r.email);
    const start = (g.find((r) => r.start && r.start >= today) || g.find((r) => r.start) || {}).start;
    const deadline = (g.find((r) => r.deadline && r.deadline >= today) || g.find((r) => r.deadline) || {}).deadline;
    for (const s of into) {
      s.unique++;
      s.upcoming += upcoming;
      s.open += open;
      s.withEmail += withEmail;
      if (start) s.starts[Number(start.slice(5, 7)) - 1]++;
      if (deadline) s.deadlines[Number(deadline.slice(5, 7)) - 1]++;
    }
  }
  return { total, byCountry, groups: groups.size };
}

// --- panel data ---
// Google groups close variants and reports the group's numbers for each spelling, so
// a keyword with the same volume, CPC and 12-month series as an earlier one in its set
// is marked grouped and counted once. Flagged keywords (seeds.json "flagged": broad or
// ambiguous terms) are shown with their reason but never counted.
// Row: [keyword, lang, volume, cpc, cmp, trend, series, grouped, flag]
function summariseSet(entries, flagged = {}) {
  const seen = new Set();
  let volume = 0, cpcW = 0, cmpW = 0, grouped = 0, measured = 0, flaggedCount = 0;
  const series = [];
  const rows = entries.map(([k, lang, x]) => {
    const flag = flagged[k] || null;
    if (!x || x.v == null) return [k, lang, null, null, null, null, null, 0, flag];
    if (flag) { flaggedCount++; return [k, lang, x.v, x.cpc, x.cmp, x.t, x.s, 0, flag]; }
    measured++;
    let isGrouped = 0;
    if (x.v > 0) {
      const sig = `${x.v}|${x.cpc}|${x.s.join(',')}`;
      if (seen.has(sig)) { isGrouped = 1; grouped++; }
      else {
        seen.add(sig);
        volume += x.v;
        cpcW += (x.cpc || 0) * x.v;
        cmpW += (x.cmp || 0) * x.v;
        x.s.forEach((v, i) => { series[i] = (series[i] || 0) + (v || 0); });
      }
    }
    return [k, lang, x.v, x.cpc, x.cmp, x.t, x.s, isGrouped, null];
  });
  return {
    summary: {
      volume: measured ? volume : null, keywords: entries.length, measured, grouped, flagged: flaggedCount,
      cpc: volume ? round2(cpcW / volume) : null, cmp: volume ? round2(cmpW / volume) : null, series,
    },
    rows,
  };
}

export function buildPanel({ seeds, cache, rows, today, now = Date.parse(today) }) {
  const cfg = seeds.collector || {};
  const idx = seedIndex(seeds);
  const jobs = planJobs(seeds);
  const fest = festivalStats(rows, today);
  const setIds = Object.keys(seeds.sets);
  const flagged = flaggedIndex(seeds);
  const keywords = {};

  const markets = seeds.markets.map((m) => {
    const entries = jobs.filter((j) => j.kind === 'volume' && j.market === m.id).map((j) => cache.jobs[j.id]).filter(Boolean);
    const kw = Object.assign({}, ...entries.map((e) => e.kw));
    const langs = new Set(['any', ...m.kw]);
    const sets = {};
    keywords[m.id] = [];
    for (const set of setIds) {
      const mine = [...idx]
        .filter(([, v]) => v.set === set && [...v.langs].some((l) => langs.has(l)))
        .map(([k, v]) => [k, [...v.langs].find((l) => langs.has(l)), kw[k] === undefined ? null : kw[k]]);
      const { summary, rows: out } = summariseSet(mine, flagged);
      sets[set] = summary;
      for (const r of out) keywords[m.id].push([r[0], set, ...r.slice(1)]);
    }
    const at = entries.map((e) => e.at).sort()[0] || null;
    return {
      id: m.id, label: m.label, country: m.country, tier: m.tier, note: m.note || null,
      fetchedAt: at, last: (entries.find((e) => e.last) || {}).last || null,
      fest: m.country ? fest.byCountry[m.country] || blankStats() : fest.total,
      sets,
    };
  });

  // suggestions not already in the seeds, strongest first
  const cands = new Map();
  for (const j of jobs.filter((x) => x.kind === 'discovery')) {
    const e = cache.jobs[j.id];
    if (!e) continue;
    for (const [k, x] of Object.entries(e.kw)) {
      if (!x || idx.has(k)) continue;
      const c = cands.get(k) || { k, set: j.set, lang: j.lang, v: -1, cpc: null, cmp: null, market: null, heads: [] };
      if (x.v > c.v) Object.assign(c, { v: x.v, cpc: x.cpc, cmp: x.cmp, market: j.market });
      if (!c.heads.includes(j.head)) c.heads.push(j.head);
      cands.set(k, c);
    }
  }
  const candidates = [...cands.values()].sort((a, b) => b.v - a.v || a.k.localeCompare(b.k)).slice(0, 500);

  const due = dueQueue(jobs, cache, now, cfg.maxAgeDays ?? 28);
  const months = markets.map((m) => m.last).filter(Boolean).sort();
  return {
    generated: new Date(now).toISOString(),
    dataMonth: months.length ? months[months.length - 1] : null,
    sets: setIds.map((id) => ({ id, label: seeds.sets[id].label, short: seeds.sets[id].short || seeds.sets[id].label })),
    festivals: { groups: fest.groups, rows: rows.length },
    progress: {
      jobs: jobs.length,
      done: jobs.filter((j) => cache.jobs[j.id]).length,
      due: due.length,
      dueNew: due.filter((d) => d.why === 'new').length,
      budget: cfg.budget ?? null,
      floor: cfg.floor ?? null,
      next: due.slice(0, cfg.budget || 20).map((d) => d.job.id),
    },
    lastRun: cache.runs.length ? cache.runs[cache.runs.length - 1] : null,
    markets,
    keywords,
    candidates,
  };
}

// --- files ---
// One keyword per line, keys sorted, so a refresh diffs readably.
export function serializeCache(cache) {
  const out = ['{', '"jobs": {'];
  const ids = Object.keys(cache.jobs).sort();
  ids.forEach((id, i) => {
    const { kw = {}, ...meta } = cache.jobs[id];
    const head = JSON.stringify(meta).slice(0, -1);
    out.push(`${JSON.stringify(id)}: ${head}${Object.keys(meta).length ? ',' : ''}"kw": {`);
    const ks = Object.keys(kw).sort();
    ks.forEach((k, j) => out.push(`  ${JSON.stringify(k)}: ${JSON.stringify(kw[k])}${j < ks.length - 1 ? ',' : ''}`));
    out.push(`}}${i < ids.length - 1 ? ',' : ''}`);
  });
  out.push('},', '"runs": [');
  cache.runs.forEach((r, i) => out.push(`  ${JSON.stringify(r)}${i < cache.runs.length - 1 ? ',' : ''}`));
  out.push(']', '}');
  return out.join('\n') + '\n';
}

// Top-level keys on their own lines, one market / keyword row / candidate per line.
export function serializePanel(panel) {
  const lines = (arr) => '[\n' + arr.map((x) => JSON.stringify(x)).join(',\n') + '\n]';
  const parts = Object.entries(panel).map(([k, v]) => {
    let body;
    if (Array.isArray(v) && k !== 'sets') body = lines(v);
    else if (k === 'keywords') body = '{\n' + Object.entries(v).map(([m, rows]) => `${JSON.stringify(m)}: ${lines(rows)}`).join(',\n') + '\n}';
    else body = JSON.stringify(v);
    return `${JSON.stringify(k)}: ${body}`;
  });
  return '{\n' + parts.join(',\n') + '\n}\n';
}
