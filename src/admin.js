// MVP navigator: /admin, private behind Cloudflare Access (see access.js).
// Phase 1 is read-mostly: how the DCP test is doing (funnel, keywords, gates),
// hand-entered Google Ads spend, and the keyword panel's collector status.
//
//   GET  /admin                 the page (HTML)
//   GET  /admin/app.js          its script (served separately so the CSP needs no inline script)
//   GET  /admin/api/summary     everything the page shows, for ?from=&to=&mode=live|test
//   POST /admin/api/settings    { launch_date, price, margin }
//   POST /admin/api/spend       { day, spend, clicks, impressions, note }
//   POST /admin/api/spend/delete { day }
//
// Keyword text in the data comes from ad URLs, i.e. anyone can put HTML in it: the
// page only ever renders values with textContent.
import { verifyAccess } from './access.js';

const TEST_DAYS = 28;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SETTING_KEYS = ['launch_date', 'price', 'margin'];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    + "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'same-origin',
};
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function handleAdmin(request, env, url) {
  const who = await verifyAccess(request, env);
  if (!who) return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });

  const path = url.pathname.replace(/\/+$/, '') || '/admin';
  if (request.method === 'GET') {
    if (path === '/admin') return new Response(PAGE, { headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
    if (path === '/admin/app.js') return new Response(APP_JS, { headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' } });
    if (path === '/admin/api/summary') return json(await summary(env, url, who));
  }
  if (request.method === 'POST') {
    // Only JSON from our own pages: a cross-site form can't send either.
    const sameOrigin = request.headers.get('Origin') === url.origin;
    const isJson = (request.headers.get('Content-Type') || '').startsWith('application/json');
    if (!sameOrigin || !isJson) return json({ ok: false, error: 'bad request' }, 400);
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
    if (path === '/admin/api/settings') return saveSettings(env, body);
    if (path === '/admin/api/spend') return saveSpend(env, body);
    if (path === '/admin/api/spend/delete') return deleteSpend(env, body);
  }
  return new Response('Not found', { status: 404 });
}

// --- writes ------------------------------------------------------------------
async function saveSettings(env, body) {
  const at = new Date().toISOString();
  const clean = {};
  if ('launch_date' in body) {
    if (body.launch_date && !DATE_RE.test(body.launch_date)) return json({ ok: false, error: 'launch_date must be YYYY-MM-DD' }, 400);
    clean.launch_date = body.launch_date || null;
  }
  if ('price' in body) {
    const p = num(body.price);
    if (p == null || p <= 0 || p > 100000) return json({ ok: false, error: 'price must be a positive number' }, 400);
    clean.price = String(p);
  }
  if ('margin' in body) {
    const m = num(body.margin);
    if (m == null || m <= 0 || m > 100) return json({ ok: false, error: 'margin must be 1-100 (%)' }, 400);
    clean.margin = String(m);
  }
  const stmts = Object.entries(clean).map(([k, v]) => env.DB.prepare(
    'INSERT INTO settings (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at'
  ).bind(k, v, at));
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, saved: Object.keys(clean) });
}

async function saveSpend(env, body) {
  const spend = num(body.spend), clicks = num(body.clicks), impressions = num(body.impressions);
  if (!DATE_RE.test(body.day || '')) return json({ ok: false, error: 'day must be YYYY-MM-DD' }, 400);
  if (spend == null || spend < 0) return json({ ok: false, error: 'spend must be a number' }, 400);
  if ((clicks != null && clicks < 0) || (impressions != null && impressions < 0)) return json({ ok: false, error: 'clicks and impressions must be ≥ 0' }, 400);
  await env.DB.prepare(
    `INSERT INTO ad_spend (day, spend, clicks, impressions, note, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET spend = excluded.spend, clicks = excluded.clicks,
       impressions = excluded.impressions, note = excluded.note, at = excluded.at`
  ).bind(body.day, spend, clicks, impressions, body.note ? String(body.note).slice(0, 200) : null, new Date().toISOString()).run();
  return json({ ok: true });
}

async function deleteSpend(env, body) {
  if (!DATE_RE.test(body.day || '')) return json({ ok: false, error: 'day must be YYYY-MM-DD' }, 400);
  await env.DB.prepare('DELETE FROM ad_spend WHERE day = ?').bind(body.day).run();
  return json({ ok: true });
}

// --- the summary -------------------------------------------------------------
async function summary(env, url, who) {
  const settings = Object.fromEntries(
    (await env.DB.prepare('SELECT key, value FROM settings').all()).results.map((r) => [r.key, r.value])
  );
  const today = isoDay(Date.now());
  const launch = DATE_RE.test(settings.launch_date || '') ? settings.launch_date : null;
  const qFrom = url.searchParams.get('from'), qTo = url.searchParams.get('to');
  const from = DATE_RE.test(qFrom || '') ? qFrom : (launch || isoDay(Date.now() - (TEST_DAYS - 1) * DAY_MS));
  const to = DATE_RE.test(qTo || '') ? qTo : today;
  const live = url.searchParams.get('mode') !== 'test' ? 1 : 0;
  const start = `${from}T00:00:00.000Z`, end = `${isoDay(Date.parse(to) + DAY_MS)}T00:00:00.000Z`;
  // Launch checks and test purchases carry utm_source=test; they never count.
  const notTest = (t) => `COALESCE(${t}.source, '') NOT IN ('test', 'launchcheck', 'botcheck')`;

  const [byKind, viewTotal, byKeyword, eventDays, viewDays, orderDays, spendDays, orderTotals] = await Promise.all([
    env.DB.prepare(`SELECT kind, COUNT(*) AS n FROM events e WHERE e.at >= ? AND e.at < ? AND ${notTest('e')} GROUP BY kind`).bind(start, end).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM views v WHERE v.at >= ? AND v.at < ? AND ${notTest('v')}`).bind(start, end).all(),
    env.DB.prepare(
      `SELECT term, matchtype, adgroup, country, SUM(views) AS views, SUM(clicks) AS clicks, SUM(quotes) AS quotes,
              SUM(paid) AS paid, SUM(revenue_cents) AS revenue_cents
       FROM (
         SELECT COALESCE(v.term, '(no keyword)') AS term, v.matchtype, v.adgroup, v.country,
                1 AS views, 0 AS clicks, 0 AS quotes, 0 AS paid, 0 AS revenue_cents
         FROM views v WHERE v.at >= ? AND v.at < ? AND ${notTest('v')}
         UNION ALL
         SELECT COALESCE(e.term, '(no keyword)'), e.matchtype, e.adgroup, e.country,
                0, e.kind = 'order_click', e.kind = 'quote', o.id IS NOT NULL, COALESCE(o.amount_total, 0)
         FROM events e LEFT JOIN orders o ON o.ref = e.id AND o.livemode = ?
         WHERE e.at >= ? AND e.at < ? AND ${notTest('e')}
       )
       GROUP BY term, matchtype, adgroup, country
       ORDER BY paid DESC, quotes DESC, clicks DESC, views DESC LIMIT 200`
    ).bind(start, end, live, start, end).all(),
    env.DB.prepare(
      `SELECT substr(e.at, 1, 10) AS day, SUM(e.kind = 'order_click') AS clicks, SUM(e.kind = 'quote') AS quotes
       FROM events e WHERE e.at >= ? AND e.at < ? AND ${notTest('e')} GROUP BY day`
    ).bind(start, end).all(),
    env.DB.prepare(
      `SELECT substr(v.at, 1, 10) AS day, COUNT(*) AS views FROM views v WHERE v.at >= ? AND v.at < ? AND ${notTest('v')} GROUP BY day`
    ).bind(start, end).all(),
    env.DB.prepare(
      `SELECT substr(at, 1, 10) AS day, COUNT(*) AS paid, SUM(amount_total) AS revenue_cents
       FROM orders WHERE livemode = ? AND at >= ? AND at < ? GROUP BY day`
    ).bind(live, start, end).all(),
    env.DB.prepare('SELECT day, spend, clicks, impressions, note FROM ad_spend WHERE day >= ? AND day <= ? ORDER BY day').bind(from, to).all(),
    env.DB.prepare('SELECT COUNT(*) AS paid, COALESCE(SUM(amount_total), 0) AS revenue_cents FROM orders WHERE livemode = ? AND at >= ? AND at < ?').bind(live, start, end).all(),
  ]);

  const kinds = Object.fromEntries(byKind.results.map((r) => [r.kind, r.n]));
  const spendRows = spendDays.results;
  const spend = spendRows.reduce((s, r) => s + (r.spend || 0), 0);
  const adClicks = spendRows.reduce((s, r) => s + (r.clicks || 0), 0);
  const impressions = spendRows.reduce((s, r) => s + (r.impressions || 0), 0);
  const paid = orderTotals.results[0].paid, revenue = orderTotals.results[0].revenue_cents / 100;
  const funnel = {
    views: viewTotal.results[0].n, orderClicks: kinds.order_click || 0, quotes: kinds.quote || 0, paid, revenue,
    spend, adClicks, impressions,
    ctr: impressions ? adClicks / impressions : null,
    cpc: adClicks ? spend / adClicks : null,
  };

  const panel = await keywordPanel(env, url);

  // One row per day of the range, so gaps read as zeros.
  const days = [];
  const byDay = (rows) => Object.fromEntries(rows.map((r) => [r.day, r]));
  const ev = byDay(eventDays.results), vd = byDay(viewDays.results), od = byDay(orderDays.results), sd = byDay(spendRows);
  for (let t = Date.parse(from); t <= Date.parse(to) && days.length < 120; t += DAY_MS) {
    const d = isoDay(t);
    days.push({
      day: d, views: vd[d]?.views || 0, clicks: ev[d]?.clicks || 0, quotes: ev[d]?.quotes || 0,
      paid: od[d]?.paid || 0, revenue: (od[d]?.revenue_cents || 0) / 100, spend: sd[d]?.spend ?? null,
    });
  }

  return {
    who: who.email, today, range: { from, to, mode: live ? 'live' : 'test' },
    settings: { launch_date: launch, price: num(settings.price) ?? 149, margin: num(settings.margin) },
    funnel, gates: gates({ launch, today, settings, funnel }),
    keywords: byKeyword.results.map((r) => ({ ...r, revenue: r.revenue_cents / 100 })),
    days, spend: spendRows, panel,
  };
}

// The day-28 decision rules from the test plan, evaluated on the live numbers.
function gates({ launch, today, settings, funnel }) {
  const P = num(settings.price) ?? 149, m = num(settings.margin);
  const breakEven = m ? P * (m / 100) : null;
  const leads = funnel.quotes + funnel.paid;
  const costPerLead = leads && funnel.spend ? funnel.spend / leads : null;
  const costPerOrder = funnel.paid && funnel.spend ? funnel.spend / funnel.paid : null;
  const day = launch ? Math.floor((Date.parse(today) - Date.parse(launch)) / DAY_MS) + 1 : null;
  const notes = [];
  if (!launch) notes.push('Set the launch date (the day the ads started) to count days.');
  if (!m) notes.push('Set your gross margin to compute break-even (price × margin).');
  if (funnel.impressions && funnel.ctr != null && funnel.ctr < 0.04) notes.push(`CTR ${(funnel.ctr * 100).toFixed(1)}% is under the 4% mechanics bar: check ad copy and search terms.`);
  if (funnel.adClicks >= 50 && funnel.orderClicks + funnel.quotes === 0) notes.push('Day-14 rule: 50+ ad clicks and nobody clicked Order or asked for a quote. Change one thing on the page and log it.');

  let status = 'collecting', label = 'Collecting data';
  const priced = breakEven == null || costPerLead == null || costPerLead <= breakEven;
  if (funnel.paid >= 1 || funnel.quotes >= 3) {
    [status, label] = priced ? ['traction', 'Traction'] : ['weak', 'Weak: leads cost more than break-even'];
  } else if (leads === 0 && funnel.adClicks >= 100) {
    [status, label] = ['none', 'No signal: 100+ clicks, no leads'];
  } else if (leads > 0) {
    [status, label] = ['weak', 'Some leads, not yet traction'];
  }
  const final = day != null && day >= TEST_DAYS;
  return { day, of: TEST_DAYS, final, status, label, P, margin: m, breakEven, leads, costPerLead, costPerOrder, notes };
}

// The keyword panel's own data file, read through the assets binding so it works
// even once /fest-map/* sits behind Access.
async function keywordPanel(env, url) {
  try {
    if (!env.ASSETS) return { ok: false, reason: 'no ASSETS binding' };
    const res = await env.ASSETS.fetch(new Request(new URL('/fest-map/keypanel/data.json', url.origin)));
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const d = await res.json();
    const r = d.lastRun || null;
    return {
      ok: true, generated: d.generated, dataMonth: d.dataMonth,
      measured: (d.markets || []).filter((m) => m.fetchedAt).length, markets: (d.markets || []).length,
      progress: d.progress ? { done: d.progress.done, due: d.progress.due, jobs: d.progress.jobs } : null,
      lastRun: r ? { at: r.at, spent: r.spent, stored: (r.jobs || []).length, errors: r.errors || [], after: r.after } : null,
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// --- the page ----------------------------------------------------------------
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MVP navigator | ingest.mov</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;600&display=swap">
<link rel="stylesheet" href="/assets/pages.css">
<style>
  body { font-size: 15px; }
  .wrap { max-width: 1180px; }
  header.top .wrap { flex-wrap: wrap; }
  .top nav { display: flex; gap: 16px; flex-wrap: wrap; }
  section { padding: 28px 0; }
  h2 { font-size: 20px; margin-bottom: 14px; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
  .bar label { display: grid; gap: 4px; font-family: var(--mono); font-size: 12px; color: var(--muted); }
  input, select, button { font: 14px var(--sans); color: var(--txt); background: var(--panel2); border: 1px solid var(--line2); border-radius: 8px; padding: 8px 10px; min-height: 38px; }
  button { cursor: pointer; background: var(--accent); color: var(--accent-ink); border: 0; font-weight: 600; }
  button.ghost { background: transparent; color: var(--txt); border: 1px solid var(--line2); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .tile .k { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .tile .v { font-size: 26px; font-weight: 600; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .tile .s { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .status { display: inline-block; font-family: var(--mono); font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line2); }
  .status.traction { border-color: #4caf7a; color: #7fd6a3; }
  .status.weak { border-color: var(--accent); color: var(--accent); }
  .status.none { border-color: #d0605e; color: #f0908e; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  th { font-family: var(--mono); font-weight: 500; font-size: 12px; color: var(--muted); }
  td.n, th.n { text-align: right; }
  .scroll { overflow-x: auto; }
  .notes li { color: var(--muted); margin: 4px 0; }
  .muted { color: var(--muted); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
  #msg { min-height: 20px; font-family: var(--mono); font-size: 12px; color: var(--accent); }
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <span class="brand">ingest.mov<span>MVP navigator</span></span>
    <nav>
      <a href="/dcp/" target="_blank" rel="noopener">DCP page</a>
      <a href="/fest-map/keypanel/" target="_blank" rel="noopener">Keyword panel</a>
      <a href="https://dashboard.stripe.com/" target="_blank" rel="noopener">Stripe</a>
      <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">Cloudflare</a>
    </nav>
  </div>
</header>
<main class="wrap">
  <section>
    <div class="bar">
      <label>From<input type="date" id="from"></label>
      <label>To<input type="date" id="to"></label>
      <label>Orders<select id="mode"><option value="live">live</option><option value="test">sandbox</option></select></label>
      <button id="reload">Update</button>
      <span class="muted" id="who"></span>
    </div>
    <div id="msg" role="status"></div>
  </section>
  <section aria-labelledby="h-status"><h2 id="h-status">Where the test stands</h2><div id="status"></div></section>
  <section aria-labelledby="h-funnel"><h2 id="h-funnel">Funnel</h2><div class="tiles" id="funnel"></div><p class="muted" id="visits-note"></p></section>
  <section aria-labelledby="h-kw"><h2 id="h-kw">By keyword</h2><div class="scroll" id="keywords"></div></section>
  <section aria-labelledby="h-days"><h2 id="h-days">Day by day</h2><div class="scroll" id="days"></div></section>
  <section class="grid2">
    <div>
      <h2>Ad spend (from Google Ads)</h2>
      <div class="bar" id="spend-form">
        <label>Day<input type="date" id="s-day" required></label>
        <label>Spend $<input type="number" id="s-spend" min="0" step="0.01" required style="width:90px"></label>
        <label>Clicks<input type="number" id="s-clicks" min="0" style="width:80px"></label>
        <label>Impr.<input type="number" id="s-impr" min="0" style="width:90px"></label>
        <label>Note<input type="text" id="s-note" maxlength="200"></label>
        <button id="s-save">Save</button>
      </div>
      <div class="scroll" id="spend" style="margin-top:12px"></div>
    </div>
    <div>
      <h2>Settings</h2>
      <div class="bar">
        <label>Launch date<input type="date" id="launch"></label>
        <label>Price P $<input type="number" id="price" min="1" step="1" style="width:90px"></label>
        <label>Margin %<input type="number" id="margin" min="1" max="100" style="width:80px"></label>
        <button id="set-save">Save</button>
      </div>
      <h2 style="margin-top:26px">Keyword panel</h2>
      <div id="panel"></div>
    </div>
  </section>
</main>
<script src="/admin/app.js" defer></script>
</body>
</html>`;

const APP_JS = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(k == null ? '' : String(k)));
    return n;
  };
  const money = (v, d = 0) => v == null ? '–' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const int = (v) => v == null ? '–' : Number(v).toLocaleString('en-US');
  const pct = (v) => v == null ? '–' : (v * 100).toFixed(1) + '%';
  const msg = (t) => { $('msg').textContent = t || ''; };

  function table(cols, rows) {
    const t = el('table');
    t.append(el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { class: c.n ? 'n' : null }, c.h)))));
    const tb = el('tbody');
    if (!rows.length) tb.append(el('tr', {}, el('td', { colspan: cols.length, class: 'muted' }, 'Nothing yet.')));
    for (const r of rows) tb.append(el('tr', {}, ...cols.map((c) => el('td', { class: c.n ? 'n' : null }, c.f ? c.f(r) : r[c.k]))));
    t.append(tb);
    return t;
  }
  function tile(k, v, s) { return el('div', { class: 'tile' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), el('div', { class: 's' }, s || '')); }

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || ('HTTP ' + res.status));
    return out;
  }

  async function load() {
    msg('Loading…');
    const q = new URLSearchParams();
    if ($('from').value) q.set('from', $('from').value);
    if ($('to').value) q.set('to', $('to').value);
    q.set('mode', $('mode').value);
    const res = await fetch('/admin/api/summary?' + q);
    if (!res.ok) { msg('Could not load (HTTP ' + res.status + ')'); return; }
    const d = await res.json();
    render(d);
    msg('');
  }

  function render(d) {
    $('who').textContent = d.who ? 'Signed in as ' + d.who : '';
    $('from').value = d.range.from; $('to').value = d.range.to; $('mode').value = d.range.mode;
    $('launch').value = d.settings.launch_date || ''; $('price').value = d.settings.price ?? ''; $('margin').value = d.settings.margin ?? '';
    if (!$('s-day').value) $('s-day').value = d.today;

    const g = d.gates, st = $('status');
    st.replaceChildren(
      el('p', {}, el('span', { class: 'status ' + g.status }, g.label), '  ',
        g.day != null ? 'Day ' + g.day + ' of ' + g.of + (g.final ? ' (decision day reached)' : '') : 'Launch date not set'),
      el('div', { class: 'tiles' },
        tile('Leads', int(g.leads), 'quotes + paid orders'),
        tile('Cost per lead', money(g.costPerLead), g.breakEven != null ? 'break-even ' + money(g.breakEven) : 'set margin'),
        tile('Cost per order', money(g.costPerOrder), 'P = ' + money(g.P))),
      g.notes.length ? el('ul', { class: 'notes' }, ...g.notes.map((n) => el('li', {}, n))) : '');

    const f = d.funnel;
    $('funnel').replaceChildren(
      tile('Page views /dcp', int(f.views), 'counted by the page'),
      tile('Order clicks', int(f.orderClicks), 'went to Stripe'),
      tile('Quotes', int(f.quotes), 'form requests'),
      tile('Paid orders', int(f.paid), money(f.revenue) + ' revenue'),
      tile('Ad spend', money(f.spend, 2), int(f.adClicks) + ' clicks'),
      tile('CPC / CTR', money(f.cpc, 2), 'CTR ' + pct(f.ctr)));
    $('visits-note').textContent = 'Page views: every time /dcp/ opens in a browser, reloads included. Bots, link previews and '
      + 'prefetches never count; a browser that blocks scripts doesn\'t either, so read it as a floor. Compare with ad clicks from Google Ads.';

    $('keywords').replaceChildren(table([
      { h: 'Keyword', k: 'term' }, { h: 'Match', k: 'matchtype' }, { h: 'Ad group', k: 'adgroup' }, { h: 'Country', k: 'country' },
      { h: 'Views', k: 'views', n: 1 }, { h: 'Order clicks', k: 'clicks', n: 1 }, { h: 'Quotes', k: 'quotes', n: 1 }, { h: 'Paid', k: 'paid', n: 1 },
      { h: 'Revenue', f: (r) => money(r.revenue), n: 1 }], d.keywords));

    $('days').replaceChildren(table([
      { h: 'Day', k: 'day' }, { h: 'Views', f: (r) => int(r.views), n: 1 }, { h: 'Order clicks', k: 'clicks', n: 1 },
      { h: 'Quotes', k: 'quotes', n: 1 }, { h: 'Paid', k: 'paid', n: 1 }, { h: 'Revenue', f: (r) => money(r.revenue), n: 1 },
      { h: 'Spend', f: (r) => money(r.spend, 2), n: 1 }], d.days.slice().reverse()));

    $('spend').replaceChildren(table([
      { h: 'Day', k: 'day' }, { h: 'Spend', f: (r) => money(r.spend, 2), n: 1 }, { h: 'Clicks', f: (r) => int(r.clicks), n: 1 },
      { h: 'Impr.', f: (r) => int(r.impressions), n: 1 }, { h: 'Note', k: 'note' },
      { h: '', f: (r) => { const b = el('button', { class: 'ghost', type: 'button' }, 'Delete'); b.onclick = () => del(r.day); return b; } }],
      d.spend.slice().reverse()));

    const p = d.panel, box = $('panel');
    if (!p.ok) { box.replaceChildren(el('p', { class: 'muted' }, 'Unavailable: ' + p.reason)); return; }
    const lr = p.lastRun;
    box.replaceChildren(
      el('p', {}, int(p.measured) + ' of ' + int(p.markets) + ' markets measured · data month ' + (p.dataMonth || '–')),
      p.progress ? el('p', { class: 'muted' }, int(p.progress.done) + ' jobs done, ' + int(p.progress.due) + ' due') : '',
      lr ? el('p', { class: 'muted' }, 'Last collector run ' + lr.at.slice(0, 16).replace('T', ' ') + ' UTC: '
        + lr.stored + ' stored, ' + lr.spent + ' requests' + (lr.after != null ? ', ' + lr.after + ' left in the pool' : '')) : '',
      lr && lr.errors.length ? el('ul', { class: 'notes' }, ...lr.errors.map((e) => el('li', {}, e))) : '',
      el('p', {}, el('a', { href: '/fest-map/keypanel/', target: '_blank', rel: 'noopener' }, 'Open the keyword panel →')));
  }

  async function del(day) {
    if (!confirm('Delete the spend entry for ' + day + '?')) return;
    try { await post('/admin/api/spend/delete', { day }); await load(); } catch (e) { msg(e.message); }
  }
  $('reload').onclick = load;
  $('s-save').onclick = async () => {
    try {
      await post('/admin/api/spend', { day: $('s-day').value, spend: $('s-spend').value, clicks: $('s-clicks').value, impressions: $('s-impr').value, note: $('s-note').value });
      $('s-spend').value = $('s-clicks').value = $('s-impr').value = $('s-note').value = '';
      await load(); msg('Spend saved.');
    } catch (e) { msg(e.message); }
  };
  $('set-save').onclick = async () => {
    try {
      const body = {};
      if ($('launch').value !== '') body.launch_date = $('launch').value;
      if ($('price').value !== '') body.price = $('price').value;
      if ($('margin').value !== '') body.margin = $('margin').value;
      await post('/admin/api/settings', body); await load(); msg('Settings saved.');
    } catch (e) { msg(e.message); }
  };
  load();
})();
`;
