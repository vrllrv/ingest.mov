// ==UserScript==
// @name         FilmFreeway date scraper — ingest.mov fest-map
// @namespace    ingest.mov
// @version      0.5.0
// @description  Crawl FilmFreeway festival detail pages in your OWN browser session (so Cloudflare is already satisfied) to collect submission deadlines + event dates, then export JSON for the fest-map ingest. Throttled, resumable, weekly-diff friendly.
// @author       ingest.mov
// @match        https://filmfreeway.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * HOW THIS WORKS
 *  - It runs ON filmfreeway.com, so fetch('/<slug>') is SAME-ORIGIN and carries
 *    your cf_clearance cookie — no Cloudflare 403, no headless browser.
 *  - Paste the slug list (tools/ff-slugs.json) into the panel, press Start.
 *  - It fetches one festival page every ~18s (polite; matches their crawl-delay),
 *    extracts dates, and saves progress to localStorage so you can stop/resume.
 *  - Export downloads filmfreeway-dates.json keyed by `ff:<slug>` for the ingest.
 *
 * STATUS: extractDates() is finalized (v0.4) — festival "Event Date" is the
 * PRIMARY field; opens/deadlines/notification are kept as secondary data.
 *
 * WORKFLOW:
 *  1. Coverage test: paste tools/ff-slugs-sample.json, set throttle ~8s, Start,
 *     Export, and check how many records have eventStart.
 *  2. Full backfill: paste tools/ff-slugs.json, throttle ~18s, Start (resumable).
 *  3. Export filmfreeway-dates.json -> commit -> ingest merges it.
 * The "Scrape THIS page" button still dumps a rich diagnostic for any odd page.
 */

(function () {
  'use strict';
  if (window.top !== window.self) return; // top frame only

  const LS_KEY = 'ffscrape:v1';
  const DEFAULT_THROTTLE_MS = 18000;

  // ---- persistent state ----------------------------------------------------
  const load = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
  const save = () => localStorage.setItem(LS_KEY, JSON.stringify(state));
  const state = Object.assign({ results: {}, errors: {}, queue: [], throttle: DEFAULT_THROTTLE_MS }, load());

  let running = false;
  let timer = null;

  // ---- slug parsing --------------------------------------------------------
  // Accepts: a JSON array (objects with slug/url, or strings), or newline/space
  // separated slugs or full URLs.
  function parseSlugInput(text) {
    text = (text || '').trim();
    if (!text) return [];
    const toSlug = (s) => String(s).trim().replace(/\/+$/, '').split('/').pop().split('?')[0];
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) return j.map((x) => toSlug(typeof x === 'string' ? x : (x.slug || x.url))).filter(Boolean);
    } catch { /* not JSON, fall through */ }
    return text.split(/[\s,]+/).map(toSlug).filter(Boolean);
  }

  // ---- THE EXTRACTOR -------------------------------------------------------
  // FilmFreeway detail pages list labeled date rows: "<date(s)>  <Label>".
  //   "June 3 – 14, 2026   Event Date"      -> festival start/end  (PRIMARY)
  //   "Sep 30, 2025   Opening Date"         -> submissions open
  //   "Feb 27, 2026   Regular Deadline"     -> a submission deadline (tiered)
  //   "May 1, 2026    Notification Date"    -> results notification
  // Event date is the centre of the effort; deadlines/opens are kept secondary.
  const MONTH = '[A-Z][a-z]{2,8}';
  const toISO = (s) => { const d = new Date(String(s).trim() + ' UTC'); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
  function tierOf(label) {
    const l = label.toLowerCase();
    if (/extended|final/.test(l)) return 'extended';
    if (/\blate\b/.test(l)) return 'late';
    if (/\bregular\b/.test(l)) return 'regular';
    if (/\bmid\b/.test(l)) return 'mid';
    if (/\bearly\b/.test(l)) return 'early';
    return 'other';
  }

  // Parse a festival date string into {start,end}. Handles:
  //   "June 3 – 14, 2026"            (same-month range)
  //   "May 30 – June 3, 2026"        (cross-month range)
  //   "Dec 30, 2026 – Jan 2, 2027"   (cross-year range)
  //   "June 14, 2026"                (single day)
  function parseRange(str) {
    const s = String(str).replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
    const parts = s.split(/\s*-\s*/);
    if (parts.length === 1) { const d = toISO(parts[0]); return { start: d, end: d }; }
    const a = parts[0], b = parts[1];
    const yr = (b.match(/\d{4}/) || [])[0] || '';
    const aStr = /\d{4}/.test(a) ? a : `${a}, ${yr}`;                       // borrow year from end
    const bStr = /^\d/.test(b.trim()) ? `${(a.match(/^[A-Z][a-z]+/) || [''])[0]} ${b}` : b; // borrow month from start
    return { start: toISO(aStr), end: toISO(bStr) };
  }

  function extractDates(doc, slug) {
    const out = {
      slug: slug || location.pathname.replace(/\/+$/, '').split('/').pop(),
      title: (doc.querySelector('h1') || {}).textContent?.trim() || doc.title,
      scrapedAt: new Date().toISOString(),
      eventStart: null, eventEnd: null, eventRaw: null,               // PRIMARY
      opens: null, notification: null, deadlines: [], finalDeadline: null,
    };
    const EVENT_RE = /^(.+?)\s+Event Dates?$/i;                       // label-anchored (date may be a range)
    const DATED_RE = new RegExp(`^(${MONTH} \\d{1,2},\\s*\\d{4})\\s+(\\S.*)$`); // single date + label
    const seen = new Set();

    doc.querySelectorAll('div,li,tr,p,span,dd,td').forEach((el) => {
      if (el.children.length > 3) return;                            // skip big containers
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 80) return;

      const em = t.match(EVENT_RE);
      if (em && /\d{4}/.test(em[1]) && new RegExp(MONTH).test(em[1])) {
        if (!out.eventStart) { const r = parseRange(em[1]); out.eventStart = r.start; out.eventEnd = r.end; out.eventRaw = em[1].trim(); }
        return;
      }

      const m = t.match(DATED_RE);
      if (!m) return;
      const iso = toISO(m[1]);
      const label = m[2].trim();
      if (!iso || /\$|members?:/i.test(label) || /\d{4}/.test(label)) return; // skip fee rows / bad labels
      const key = iso + '|' + label;
      if (seen.has(key)) return;
      seen.add(key);
      const l = label.toLowerCase();
      if (/opening|opens/.test(l)) { if (!out.opens || iso < out.opens) out.opens = iso; }
      else if (/notif/.test(l)) { if (!out.notification || iso > out.notification) out.notification = iso; }
      else out.deadlines.push({ date: iso, label, tier: tierOf(label) });
    });

    out.deadlines.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (out.deadlines.length) out.finalDeadline = out.deadlines[out.deadlines.length - 1].date;
    return out;
  }

  // ---- networking ----------------------------------------------------------
  async function fetchDoc(slug) {
    const res = await fetch('/' + encodeURIComponent(slug), { credentials: 'include' });
    if (res.status === 403) throw new Error('CF403'); // clearance lost
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    if (/Just a moment|cf-browser-verification|challenge-platform/i.test(html)) throw new Error('CF403');
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // ---- crawl loop ----------------------------------------------------------
  async function step() {
    if (!running) return;
    const slug = state.queue.find((s) => !state.results[s]);
    if (!slug) { stop(); log('✓ Done — nothing left in queue.'); render(); return; }
    try {
      const doc = await fetchDoc(slug);
      state.results[slug] = extractDates(doc, slug);
      delete state.errors[slug];
    } catch (e) {
      state.errors[slug] = String(e.message || e);
      if (e.message === 'CF403') {
        stop();
        log('⛔ Cloudflare blocked the request. Open/refresh a normal filmfreeway.com tab to renew clearance, then Resume.');
        save(); render(); return;
      }
    }
    save(); render();
    const jitter = 0.85 + Math.random() * 0.3; // ±15% so it's less robotic
    timer = setTimeout(step, Math.round(state.throttle * jitter));
  }

  function start() {
    const slugs = parseSlugInput(ui.slugs.value);
    if (slugs.length) state.queue = Array.from(new Set([...state.queue, ...slugs]));
    if (!state.queue.length) { log('Paste the slug list first (tools/ff-slugs.json).'); return; }
    running = true; save(); render(); log('▶ Running…'); step();
  }
  function stop() { running = false; if (timer) clearTimeout(timer); timer = null; render(); }

  // ---- export --------------------------------------------------------------
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state.results, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'filmfreeway-dates.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Restore progress in a fresh browser/profile: paste a previous export into
  // the box and click Import — those festivals are marked done so a later Start
  // skips them and only fetches what's left.
  function importDone() {
    let obj;
    try { obj = JSON.parse(ui.slugs.value); } catch (e) { log('Import: paste a previous export (JSON) into the box first.'); return; }
    if (!obj || Array.isArray(obj) || typeof obj !== 'object') { log('Import: expected the exported {slug:…} JSON.'); return; }
    let n = 0;
    for (const k in obj) { if (!state.results[k]) { state.results[k] = obj[k]; n++; } if (!state.queue.includes(k)) state.queue.push(k); }
    save(); render(); ui.slugs.value = '';
    log('Imported ' + n + ' done festivals. Now paste tools/ff-slugs.json and press Start — it skips these.');
  }

  // Rich diagnostic to LOCATE festival dates in the DOM (not for the crawl).
  // Dumps structured deadlines + every short text block that contains a date,
  // plus meta/JSON-LD, so we can see exactly where festival event dates live.
  function diagnose(doc) {
    const slug = location.pathname.replace(/\/+$/, '').split('/').pop();
    const r = { slug, title: (doc.querySelector('h1') || {}).textContent?.trim() || doc.title, parsed: extractDates(doc, slug) };

    const ld = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { ld.push(JSON.parse(s.textContent)); } catch {} });
    if (ld.length) r.jsonld = ld;

    const meta = {};
    doc.querySelectorAll('meta[property],meta[name]').forEach((m) => {
      const k = m.getAttribute('property') || m.getAttribute('name');
      if (/date|time|description/i.test(k) && m.content) meta[k] = m.content;
    });
    if (Object.keys(meta).length) r.meta = meta;

    // every short element that mentions a date or a day-range, with its text
    const DATEISH = /\b[A-Z][a-z]{2,8} \d{1,2},? \d{4}\b|\b\d{1,2}\s*[–—-]\s*\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/;
    const blocks = [];
    doc.querySelectorAll('div,li,tr,p,span,dd,td,th,dt,h1,h2,h3,h4,time').forEach((el) => {
      if (el.children.length > 3) return;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 90 && DATEISH.test(t)) blocks.push(t);
    });
    r.dateBlocks = [...new Set(blocks)].slice(0, 70);
    return r;
  }

  function scrapeCurrent() {
    const slug = location.pathname.replace(/\/+$/, '').split('/').pop();
    const data = diagnose(document);
    log('Diagnostic for "' + slug + '" — copy ALL of this to Claude:');
    ui.out.value = JSON.stringify(data, null, 2);
    ui.out.style.display = 'block';
    console.log('[ffscrape] diagnostic', slug, data);
  }

  // ---- UI ------------------------------------------------------------------
  const ui = {};
  function log(msg) { ui.status.textContent = msg; }
  function render() {
    const total = state.queue.length;
    const done = Object.keys(state.results).length;
    const errs = Object.keys(state.errors).length;
    ui.count.textContent = `${done} done / ${total} queued · ${errs} errors`;
    ui.start.textContent = running ? 'Pause' : (done ? 'Resume' : 'Start');
    ui.start.style.background = running ? '#b4541f' : '#1f6f3a';
  }
  function buildUI() {
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;z-index:2147483647;right:14px;bottom:14px;width:330px;
      background:#11151c;color:#e8ecf2;font:12px/1.45 ui-monospace,Menlo,monospace;
      border:1px solid #2a313c;border-radius:11px;box-shadow:0 14px 44px rgba(0,0,0,.55);padding:12px`;
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <b style="letter-spacing:.08em">FF DATE SCRAPER</b>
        <span id="ffc" style="margin-left:auto;color:#8a93a3"></span>
      </div>
      <textarea id="ffslugs" placeholder="paste tools/ff-slugs.json (or slugs/URLs, one per line)"
        style="width:100%;height:56px;background:#0b0e13;color:#e8ecf2;border:1px solid #2a313c;border-radius:7px;padding:6px;resize:vertical"></textarea>
      <div style="display:flex;gap:6px;align-items:center;margin:8px 0">
        <button id="ffstart" style="flex:1;border:0;border-radius:7px;color:#fff;padding:7px;cursor:pointer">Start</button>
        <button id="ffexport" style="border:0;border-radius:7px;background:#28303c;color:#e8ecf2;padding:7px 9px;cursor:pointer">Export</button>
        <button id="ffimport" style="border:0;border-radius:7px;background:#28303c;color:#e8ecf2;padding:7px 9px;cursor:pointer" title="paste a previous export into the box, then click to restore progress">Import</button>
        <label style="color:#8a93a3">throttle <input id="ffthr" type="number" value="${Math.round(state.throttle/1000)}" style="width:42px;background:#0b0e13;color:#e8ecf2;border:1px solid #2a313c;border-radius:5px;padding:3px"/>s</label>
      </div>
      <button id="ffdiag" style="width:100%;border:1px solid #2a313c;border-radius:7px;background:#0b0e13;color:#f2c14e;padding:7px;cursor:pointer;margin-bottom:6px">Scrape THIS page (diagnostic)</button>
      <div id="ffstatus" style="color:#8a93a3;min-height:16px"></div>
      <textarea id="ffout" readonly style="display:none;width:100%;height:120px;margin-top:6px;background:#0b0e13;color:#9fe0b0;border:1px solid #2a313c;border-radius:7px;padding:6px"></textarea>
      <div style="text-align:right;margin-top:6px"><a id="ffclear" style="color:#6b7585;cursor:pointer;font-size:11px">clear saved data</a></div>`;
    document.body.appendChild(box);
    ui.slugs = box.querySelector('#ffslugs');
    ui.start = box.querySelector('#ffstart');
    ui.count = box.querySelector('#ffc');
    ui.status = box.querySelector('#ffstatus');
    ui.out = box.querySelector('#ffout');
    ui.start.onclick = () => (running ? stop() : start());
    box.querySelector('#ffexport').onclick = exportJSON;
    box.querySelector('#ffimport').onclick = importDone;
    box.querySelector('#ffdiag').onclick = scrapeCurrent;
    box.querySelector('#ffthr').onchange = (e) => { state.throttle = Math.max(5, +e.target.value || 18) * 1000; save(); };
    box.querySelector('#ffclear').onclick = () => { if (confirm('Clear all scraped data + queue?')) { localStorage.removeItem(LS_KEY); location.reload(); } };
    render();
  }

  buildUI();
})();
