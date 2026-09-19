/**
 * Static site server for Cloudflare Workers
 * Serves index.html, style.css, and shader.js files
 * Files are bundled at build time by Wrangler
 */
import { handleAdmin } from './admin.js';

// Static content - bundled at build time
// Edit the actual files (index.html, style.css, src/shader.js) and redeploy
// --- fest-map "refresh now" endpoint ----------------------------------------
// POST /fest-map/refresh triggers the daily GitHub Action on demand
// (workflow_dispatch), which re-ingests the public sheet and redeploys.
// Gated by a cooldown derived from the most recent run (cron runs count too),
// so the button can't spam Festhome/Cloudflare. The GitHub token lives only
// here, as the GITHUB_DISPATCH_TOKEN Worker secret — never in the page.
const REPO = 'vrllrv/ingest.mov';
const WORKFLOW = 'refresh-festmap.yml';
const COOLDOWN_MS = 10 * 60 * 1000;
const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ingest-festmap-refresh',
});
const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function handleRefresh(env) {
  const token = env && env.GITHUB_DISPATCH_TOKEN;
  if (!token) return jsonResponse({ ok: false, error: 'refresh not configured' }, 503);
  try {
    // cooldown: when did the workflow last run (scheduled or manual)?
    const runsRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      { headers: ghHeaders(token) }
    );
    if (runsRes.ok) {
      const last = (await runsRes.json()).workflow_runs?.[0];
      if (last) {
        const age = Date.now() - new Date(last.created_at).getTime();
        if (age < COOLDOWN_MS) {
          return jsonResponse({ ok: false, cooldown: true, retryAfter: Math.ceil((COOLDOWN_MS - age) / 1000) }, 429);
        }
      }
    }
    const disp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      { method: 'POST', headers: ghHeaders(token), body: JSON.stringify({ ref: 'main' }) }
    );
    if (disp.status === 204) return jsonResponse({ ok: true, eta: 90 });
    return jsonResponse({ ok: false, error: `github ${disp.status}`, detail: (await disp.text()).slice(0, 200) }, 502);
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e) }, 502);
  }
}

// --- DCP paid-search test ----------------------------------------------------
// ingest/keywords/VALIDATION.md. The landing page is static (public/dcp/); these
// two routes record who ordered or asked for a quote, and from which ad keyword,
// in D1 (table `events`, migrations/). No cookies: the page copies the Google
// Ads ValueTrack params from its own URL onto the order links and the form.
//   GET  /go/order?t=<tier>&...  -> log, 302 to the tier's payment link with
//                                   client_reference_id = the row id (Stripe join)
//   POST /dcp/quote              -> log, notify by email, 303 to /dcp/thanks/
//   POST /dcp/v?utm_...          -> the page counting its own view (table `views`)
const ATTRIBUTION = { gclid: 'gclid', source: 'utm_source', campaign: 'utm_campaign', adgroup: 'utm_content', term: 'utm_term', matchtype: 'mt' };
const clip = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
const attribution = (params) =>
  Object.fromEntries(Object.entries(ATTRIBUTION).map(([col, param]) => [col, clip(params.get(param))]));
const newEventId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse/i;
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function insertEvent(env, row) {
  const cols = Object.keys(row); // our own keys, never user input
  await env.DB.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => row[c] ?? null))
    .run();
}

// ORDER_LINKS maps tier -> payment link: an object in wrangler.json vars, or a
// JSON string when overridden with --var / .dev.vars.
function orderLinks(env) {
  const v = env.ORDER_LINKS;
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

async function handleOrder(request, env, url) {
  const links = orderLinks(env);
  const tier = url.searchParams.get('t');
  let dest = null;
  try { dest = tier && Object.hasOwn(links, tier) ? new URL(links[tier]) : null; } catch { dest = null; }
  if (!dest) return new Response('Unknown order option. Go back to https://ingest.mov/dcp/ and pick a price.', { status: 400 });

  const id = newEventId();
  // Crawlers follow the Order buttons (one did 2 minutes after launch), which would
  // inflate the click count this test measures. They still get redirected; they're
  // just not recorded. robots.txt also disallows /go/ for the well-behaved ones.
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BOT_UA.test(ua)) {
    dest.searchParams.set('client_reference_id', id);
    return Response.redirect(dest.toString(), 302);
  }
  try {
    await insertEvent(env, {
      id, at: new Date().toISOString(), kind: 'order_click', tier,
      country: request.cf?.country ?? null, ...attribution(url.searchParams),
    });
  } catch (e) {
    console.error('order_click insert failed', e); // never block a sale on logging
  }
  dest.searchParams.set('client_reference_id', id);
  return Response.redirect(dest.toString(), 302);
}

// The landing page counts its own views with navigator.sendBeacon, which runs only
// in a browser that rendered the page: link previews and prefetches never count.
// Only from our own page (a browser always sends Origin on a POST), never from bots.
async function handleView(request, env, url) {
  const ua = request.headers.get('user-agent') || '';
  if (request.headers.get('Origin') === url.origin && ua && !BOT_UA.test(ua)) {
    const a = attribution(url.searchParams); // stored without the click ID: a view joins nothing
    try {
      await env.DB.prepare(
        'INSERT INTO views (at, country, source, campaign, adgroup, term, matchtype) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(new Date().toISOString(), request.cf?.country ?? null, a.source, a.campaign, a.adgroup, a.term, a.matchtype).run();
    } catch (e) {
      console.error('view insert failed', e);
    }
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

function notifyQuote(env, row) {
  if (!env.EMAIL || !env.LEADS_TO || !env.LEADS_FROM) return Promise.reject(new Error('quote email not configured'));
  const lines = [
    `Film: ${row.film ?? '-'}`, `Runtime: ${row.runtime_min} min`, `Source: ${row.source_format ?? '-'}`,
    `Deadline: ${row.deadline ?? '-'}`, `Festival: ${row.festival ?? '-'}`, `Email: ${row.email}`,
    '', row.message ?? '', '',
    `Country: ${row.country ?? '-'} | keyword: ${row.term ?? '-'} (${row.matchtype ?? '-'}) | ad group: ${row.adgroup ?? '-'}`,
    `Ref: ${row.id}`,
  ];
  const text = lines.join('\n');
  return env.EMAIL.send({
    to: env.LEADS_TO,
    from: { email: env.LEADS_FROM, name: 'ingest.mov DCP' },
    replyTo: row.email,
    subject: `DCP quote: ${row.film ?? 'untitled'} (${row.runtime_min} min)`,
    text,
    html: `<pre style="font:14px/1.5 monospace">${escapeHtml(text)}</pre>`,
  });
}

async function handleQuote(request, env, ctx) {
  let form;
  try { form = await request.formData(); } catch { return new Response('Bad request', { status: 400 }); }
  const thanks = new URL('/dcp/thanks/?k=quote', request.url).toString();
  if (clip(form.get('website'))) return Response.redirect(thanks, 303); // honeypot: bots fill it, people never see it

  const email = clip(form.get('email'), 254);
  const runtime = Number.parseInt(form.get('runtime'), 10);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !(runtime > 0 && runtime < 1000)) {
    return new Response('Please go back and enter a valid email and the runtime in minutes.', { status: 400 });
  }
  const row = {
    id: newEventId(), at: new Date().toISOString(), kind: 'quote', country: request.cf?.country ?? null,
    ...attribution(form), email, film: clip(form.get('film')), runtime_min: runtime,
    source_format: clip(form.get('source_format'), 80), deadline: clip(form.get('deadline'), 80),
    festival: clip(form.get('festival')), message: clip(form.get('message'), 2000),
  };

  let stored = true;
  try { await insertEvent(env, row); } catch (e) { stored = false; console.error('quote insert failed', e); }
  const mail = notifyQuote(env, row);
  if (stored) {
    ctx.waitUntil(mail.catch((e) => console.error('quote email failed', e)));
  } else {
    // Not in D1: the email is the only copy, so it has to go out before we say thanks.
    try { await mail; } catch (e) {
      console.error('quote email failed', e);
      return new Response('Sorry, your request could not be saved. Please try again in a minute.', { status: 500 });
    }
  }
  return Response.redirect(thanks, 303);
}

// --- Stripe webhook ----------------------------------------------------------
// POST /stripe/webhook records paid orders. Stripe's guidance is to fulfil from
// the event, never from the success page: a buyer can pay and never load
// /dcp/thanks/. The session's client_reference_id is the events.id that
// /go/order wrote, so a payment joins back to the ad keyword.
// Only the signing secret is needed (STRIPE_WEBHOOK_SECRET, a Worker secret) —
// no API key lives in this Worker.
const SIGNATURE_TOLERANCE_S = 300;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe-Signature: "t=<unix>,v1=<hmac>[,v1=<hmac during a secret roll>]"
// STRIPE_WEBHOOK_SECRET may hold several comma-separated secrets, so the sandbox
// and live endpoints (different secrets, same URL) both verify, and so a secret
// can be rotated without a gap.
async function stripeSignatureValid(payload, header, secret, nowS = Date.now() / 1000) {
  const secrets = String(secret ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!header || !secrets.length) return false;
  let t = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') signatures.push(v);
  }
  if (!t || !signatures.length) return false;
  const age = Math.abs(nowS - Number(t));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_S) return false; // replay guard

  const enc = new TextEncoder();
  for (const candidate of secrets) {
    const key = await crypto.subtle.importKey('raw', enc.encode(candidate), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
    if (signatures.some((s) => timingSafeEqual(s, mac))) return true;
  }
  return false;
}

// Payment Links name custom fields after their labels, so match on the label
// rather than a key we'd have to keep in sync with the Dashboard.
function readCustomFields(session) {
  const values = {};
  for (const f of session.custom_fields ?? []) {
    values[f.key] = f.text?.value ?? f.numeric?.value ?? f.dropdown?.value ?? null;
  }
  const entries = Object.entries(values);
  const find = (re) => entries.find(([k, v]) => v && re.test(k))?.[1] ?? null;
  return {
    values,
    film: find(/film|title|movie/i),
    master: entries.find(([, v]) => typeof v === 'string' && /^https?:\/\//i.test(v))?.[1] ?? find(/link|master|file/i),
  };
}

async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  if (!(await stripeSignatureValid(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('Invalid signature', { status: 400 });
  }
  let event;
  try { event = JSON.parse(payload); } catch { return new Response('Invalid payload', { status: 400 }); }

  // Delayed payment methods complete while still unpaid, so fulfil on either
  // event but only once the session is actually paid.
  const paidEvent = event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded';
  if (!paidEvent) return jsonResponse({ ok: true, ignored: event.type });
  const s = event.data?.object ?? {};
  if (s.payment_status === 'unpaid') return jsonResponse({ ok: true, pending: s.id ?? null });

  const custom = readCustomFields(s);
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO orders
       (id, at, event_id, ref, amount_total, currency, email, name, film, master_link, custom_fields, payment_status, livemode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      s.id, new Date().toISOString(), event.id ?? null, s.client_reference_id ?? null,
      s.amount_total ?? null, s.currency ?? null,
      s.customer_details?.email ?? null, s.customer_details?.name ?? null,
      custom.film, custom.master, JSON.stringify(custom.values),
      s.payment_status ?? null, s.livemode ? 1 : 0
    ).run();
  } catch (e) {
    console.error('order insert failed', e);
    return jsonResponse({ ok: false }, 500); // 500 makes Stripe retry
  }
  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    if (request.method === 'POST' && pathname === '/fest-map/refresh') {
      return handleRefresh(env);
    }
    if (request.method === 'GET' && pathname === '/go/order') {
      return handleOrder(request, env, url);
    }
    if (request.method === 'POST' && pathname === '/dcp/quote') {
      return handleQuote(request, env, ctx);
    }
    if (request.method === 'POST' && pathname === '/dcp/v') {
      return handleView(request, env, url);
    }
    if (request.method === 'POST' && pathname === '/stripe/webhook') {
      return handleStripeWebhook(request, env);
    }
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return handleAdmin(request, env, url); // private: Cloudflare Access + JWT check
    }

    // Map request to file
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    const files = {
      '/index.html': {
        content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ingest.mov</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Degular+Mono:wght@400;700&family=Swear+Display:wght@400;700&display=swap">
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <canvas id="canvas"></canvas>
    <script src="shader.js"><\/script>
</body>
</html>`,
        type: 'text/html'
      },
      '/style.css': {
        content: `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: #000;
    font-family: 'Courier New', monospace;
}

canvas {
    display: block;
    width: 100%;
    height: 100%;
}

.overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    pointer-events: none;
    z-index: 10;
}

h1 {
    font-family: "degular-mono", sans-serif;
    font-weight: 900;
    font-style: normal;
    font-size: 2rem;
    color: #fff;
    margin: 0;
    letter-spacing: 1px;
}

h1 .extension {
    font-family: "swear-display", serif;
    font-weight: 700;
    font-style: italic;
    font-size: 3.2rem;
    margin-left: -6px;
    letter-spacing: -0.05em;
}

p {
    font-family: "swear-display", serif;
    font-weight: 400;
    font-style: normal;
    font-size: 0.65rem;
    color: #fff;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin: 4px 0 0 0;
}`,
        type: 'text/css'
      },
      '/shader.js': {
        content: `const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const chars = '░▒▓█▀▄─│╱╲╲'.split('');
const gridW = Math.floor(canvas.width / 8);
const gridH = Math.floor(canvas.height / 16);

let time = 0;
let mouseX = canvas.width / 2;
let mouseY = canvas.height / 2;
let touchIntensity = 1;
let isTouching = false;
let shuffleChars = false;
let shaderPattern = 0;
let lastTapTime = 0;
const allChars = '░▒▓█▀▄─│╱╲◆◇▪▫■□▌▐▍▎◀▶▲▼◤◥◢◣╔╗╚╝╟╢╡╢═║╬╪╫╤╥╧╨╩╦╤╧╥╩╬─│┌┐└┘├┤┬┴┼'.split('');

document.addEventListener('mousemove', (e) => {
  if (!isTouching) {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }
});

// Desktop double-click for shader pattern
document.addEventListener('dblclick', (e) => {
  if (!isTouching) {
    shaderPattern = (shaderPattern + 1) % 3;
  }
  e.preventDefault();
});

document.addEventListener('touchstart', (e) => {
  isTouching = true;
  const currentTime = new Date().getTime();
  const tapLength = currentTime - lastTapTime;
  if (tapLength < 300 && tapLength > 0) {
    shaderPattern = (shaderPattern + 1) % 3;
  }
  lastTapTime = currentTime;
});

document.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) {
    isTouching = false;
  }
});

document.addEventListener('touchmove', (e) => {
  if (e.touches.length === 1) {
    mouseX = e.touches[0].clientX;
    mouseY = e.touches[0].clientY;
    touchIntensity = 2;
    shuffleChars = false;
  } else if (e.touches.length >= 2) {
    mouseX = e.touches[0].clientX;
    mouseY = e.touches[0].clientY;
    touchIntensity = 3;
    shuffleChars = true;
  }
  e.preventDefault();
}, { passive: false });

function noise(x, y, t) {
  return Math.sin(x * 0.1 + t * 0.3) * Math.cos(y * 0.1 + t * 0.2) * 0.5 + 0.5;
}

function draw() {
  time += 0.016;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 14px Courier New';
  ctx.letterSpacing = '2px';

  const mouseGridX = Math.floor(mouseX / 8);
  const mouseGridY = Math.floor(mouseY / 16);
  const pattern = shaderPattern % 5;

  // Pre-calculate pattern-specific constants
  let speedMultiplier, waveIntensity;
  if (touchIntensity === 2) {
    speedMultiplier = 2.5;
    waveIntensity = 0.5;
  } else if (touchIntensity === 3) {
    speedMultiplier = 4;
    waveIntensity = 0.7;
  } else {
    speedMultiplier = 1;
    waveIntensity = 0.3;
  }

  // Pattern-specific pre-calculations
  let fillAmount, blockFill, pulsePhase, timeOffsetX, timeOffsetY;
  if (pattern === 1) {
    fillAmount = (time * 0.4 * speedMultiplier) % (gridW * 0.8);
  } else if (pattern === 3) {
    blockFill = ((time * 0.6 * speedMultiplier) % 80) / 80;
  } else if (pattern === 4) {
    pulsePhase = Math.sin(time * 0.5 * speedMultiplier) * 0.5 + 0.5;
  }

  const timeX = time * speedMultiplier;
  const timeY = time * speedMultiplier;

  // Ingest scan beam — slow vertical sweep, brightens chars in its path
  const scanCycle = 9;
  const scanT = ((time % scanCycle) / scanCycle) * 1.2 - 0.1;
  const scanX = scanT * gridW;
  const scanWidth = 4;

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const n = noise(x, y, time);
      const dx = (mouseGridX - x) * 0.02;
      const dy = (mouseGridY - y) * 0.02;

      // Squared distance (avoid sqrt when possible)
      const distSq = (x - mouseGridX) ** 2 + (y - mouseGridY) ** 2;
      const mouseInfluence = Math.max(0, 1 - Math.sqrt(distSq) * 0.05);

      let wave, depth;

      if (pattern === 0) {
        wave = Math.sin((x + timeX * 0.5 + dx * 10) * 0.1) * waveIntensity + 0.3;
        depth = Math.sin((y - timeY * 0.3 + dy * 10) * 0.15) * (waveIntensity + 0.1) + 0.4;
      } else if (pattern === 1) {
        const distance = Math.abs(x - (gridW / 2 - gridW * 0.4 + fillAmount));
        wave = Math.sin(distance * 0.1 + timeY * 0.3) * waveIntensity + 0.3;
        depth = (distance < 5) ? 0.8 : 0.2;
      } else if (pattern === 2) {
        const scanLine = Math.floor((y + timeY * 0.5) % 8);
        const lineIntensity = (scanLine < 2) ? 0.9 : 0.1;
        wave = Math.sin(x * 0.08 + timeX * 0.2) * waveIntensity + 0.3;
        depth = lineIntensity + Math.cos(timeX * 0.6) * 0.2;
      } else if (pattern === 3) {
        const distFromCenter = Math.sqrt((x - gridW/2) ** 2 + (y - gridH/2) ** 2);
        const blockThreshold = gridH * blockFill * 0.4;
        wave = (distFromCenter < blockThreshold) ? 0.8 : 0.2;
        depth = Math.cos(Math.floor(distFromCenter / 4) * 0.5 + timeX * 0.4) * waveIntensity + 0.4;
      } else {
        const fillFromLeft = (x / gridW) * pulsePhase + (timeX * 0.2) % 1;
        wave = (fillFromLeft % 1 < 0.6) ? 0.85 : 0.25;
        depth = Math.sin((y + timeY * 0.3) * 0.15) * waveIntensity + 0.3;
      }

      let val = (n + wave + depth + mouseInfluence * (0.4 * touchIntensity)) / 2;
      val = Math.max(0, Math.min(1, val));

      let char = shuffleChars ? allChars[Math.floor(val * (allChars.length - 1))] : chars[Math.floor(val * (chars.length - 1))];
      const scanDist = Math.abs(x - scanX);
      const scanBoost = scanDist < scanWidth ? (1 - scanDist / scanWidth) * 0.55 : 0;
      const alpha = ((val * 0.8) + (mouseInfluence * 0.3 * touchIntensity)) * 0.68 + scanBoost;

      ctx.fillStyle = \`rgba(255,255,255,\${alpha})\`;
      ctx.fillText(char, x * 8, y * 16);
    }
  }

  requestAnimationFrame(draw);
}

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

draw();`,
        type: 'application/javascript'
      }
    };

    const file = files[pathname];
    if (file) {
      return new Response(file.content, {
        headers: { 'Content-Type': file.type },
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
