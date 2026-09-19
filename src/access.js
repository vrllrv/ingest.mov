// Cloudflare Access check for /admin (and anything else that must stay private).
// Access already blocks unauthenticated visitors at the edge; this verifies the
// signed JWT it forwards (Cf-Access-Jwt-Assertion) so a misconfigured or removed
// Access app can never leave /admin open. Fails closed: no config, no pass.
//
// Needs vars ACCESS_TEAM (the <team> in <team>.cloudflareaccess.com) and ACCESS_AUD
// (the application's audience tag). ACCESS_CERTS_URL overrides the key URL for tests.

const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache = { url: null, at: 0, keys: [] };

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function signingKeys(url, fresh = false) {
  if (!fresh && certsCache.url === url && Date.now() - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`access certs: HTTP ${res.status}`);
  const { keys = [] } = await res.json();
  certsCache = { url, at: Date.now(), keys };
  return keys;
}

// -> { email, sub } for a valid Access token, or null (with the reason logged).
export async function verifyAccess(request, env) {
  const team = env.ACCESS_TEAM, aud = env.ACCESS_AUD;
  if (!team || !aud) return null; // not configured yet: locked
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const header = b64urlToJson(h), payload = b64urlToJson(p);
    if (header.alg !== 'RS256') return null;

    const issuer = `https://${team}.cloudflareaccess.com`;
    const url = env.ACCESS_CERTS_URL || `${issuer}/cdn-cgi/access/certs`;
    let jwk = (await signingKeys(url)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await signingKeys(url, true)).find((k) => k.kid === header.kid); // keys rotated
    if (!jwk) return null;

    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;

    const now = Date.now() / 1000;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (!(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) return null;
    if (payload.iss !== issuer) return null;
    return { email: payload.email || null, sub: payload.sub || null };
  } catch (e) {
    console.error('access check failed', e);
    return null;
  }
}
