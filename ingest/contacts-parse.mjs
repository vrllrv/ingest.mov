// Pure contact parsers + normalisers: email / website / instagram / facebook for
// Shortfilmdepot, Festagent and Movibeta festivals, and for festival homepages.
// No I/O — the runner is contacts.mjs; fixtures are checked in test.mjs.
//
// Accuracy over coverage: every value is normalised, and anything ambiguous (two
// Instagram handles on one homepage, a URL nobody calls a website, a name shared
// by two festivals) is dropped rather than guessed.
import { decodeEntities } from './parse.mjs';

const ZERO_WIDTH = /[​-‍⁠﻿]/g; // Festagent emails can start with one

const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const onDomain = (host, domain) => !!host && !!domain && (host === domain || host.endsWith('.' + domain));

// Platforms' own addresses and pages sit right next to festival contacts
// (help@shortfilmdepot.com as a fallback, hello@festagent.com in every footer).
const PLATFORM_DOMAINS = ['shortfilmdepot.com', 'festagent.com', 'movibeta.com', 'festhome.com',
  'filmfreeway.com', 'withoutabox.com', 'reelport.com', 'clickforfestivals.com'];
const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'domain.com', 'email.com', 'yourdomain.com',
  'mysite.com', 'wixpress.com', 'sentry.io'];
// free mail providers: an address there says nothing about which website is the festival's
const FREEMAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'aol.com', 'mail.ru', 'yandex.ru', 'gmx.de', 'web.de', 'naver.com', 'qq.com', '163.com'];
const SOCIAL_HOSTS = ['instagram.com', 'facebook.com', 'fb.com', 'twitter.com', 'x.com', 'youtube.com',
  'youtu.be', 'vimeo.com', 'tiktok.com', 'linkedin.com', 'vk.com', 't.me', 'wa.me', 'google.com',
  'goo.gl', 'bit.ly', 'linktr.ee', 'flickr.com'];
const isPlatformOrSocial = (host) => [...PLATFORM_DOMAINS, ...SOCIAL_HOSTS].some((d) => onDomain(host, d));

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+​-‍⁠﻿-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function normEmail(raw) {
  if (!raw) return null;
  // mailto hrefs arrive percent-encoded ("mailto:%20info@…")
  const e = safeDecode(decodeEntities(String(raw))).replace(ZERO_WIDTH, '').trim()
    .replace(/^mailto:/i, '').split('?')[0]
    .replace(/^[<("'\s]+|[>)"'.,;:\s]+$/g, '').toLowerCase();
  if (!EMAIL_RE.test(e) || /\.(png|jpe?g|gif|webp|svg|css|js)$/.test(e)) return null; // "logo@2x.png"
  const domain = e.split('@')[1];
  if ([...PLATFORM_DOMAINS, ...PLACEHOLDER_DOMAINS].some((d) => onDomain(domain, d))) return null;
  return e;
}

// "www.x.com", "https://http://x.com/" (Shortfilmdepot has both) and "//x.com" -> absolute URL
export function normUrl(raw) {
  if (!raw) return null;
  let u = decodeEntities(String(raw)).replace(ZERO_WIDTH, '').trim().replace(/^['"(<]+|['")>.,;]+$/g, '');
  const schemes = u.match(/^(?:https?:\/\/)+/i);
  const scheme = schemes ? schemes[0].match(/https?:\/\//gi).pop().toLowerCase() : 'https://';
  u = u.replace(/^(?:https?:\/\/)+/i, '').replace(/^\/\//, '');
  let url;
  try { url = new URL(scheme + u); } catch { return null; }
  if (!/\.[a-z]{2,}$/i.test(url.hostname)) return null;
  return url.href;
}

const isFileUrl = (u) => { try { return /\.(pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif|mp4)$/i.test(new URL(u).pathname); } catch { return false; } };

export function normWebsite(raw) {
  const u = normUrl(raw);
  if (!u || isPlatformOrSocial(hostOf(u)) || isFileUrl(u)) return null;
  return u;
}

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'direct', 'about',
  'legal', 'developer', 'web', 'share', 'privacy', 'terms', 'challenge', 'oauth', '_u']);
// site builders and template footers link their OWN accounts (instagram.com/wix on a Wix site)
const BUILDER_HANDLES = new Set(['wix', 'wixstudio', 'squarespace', 'wordpress', 'wordpressdotcom', 'shopify',
  'godaddy', 'weebly', 'jimdo', 'webflow', 'hostinger', 'strikingly', 'elementor', 'ionos', 'canva', 'carrd',
  'framer', 'instagram', 'meta', 'facebook']);

// -> https://instagram.com/<handle> (Festhome's format), handle lowercased
export function normInstagram(raw) {
  if (!raw) return null;
  const s = decodeEntities(String(raw)).replace(ZERO_WIDTH, '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:[a-z]+\.)?instagram\.com\/([A-Za-z0-9._]{1,30})(?:[/?#]|$)/i);
  if (!m) return null;
  const handle = m[1].replace(/\.+$/, '').toLowerCase(); // a handle can't end with a dot
  if (!handle || IG_RESERVED.has(handle) || BUILDER_HANDLES.has(handle)) return null;
  return 'https://instagram.com/' + handle;
}

const FB_RESERVED = new Set(['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login',
  'login.php', 'home.php', 'l.php', 'events', 'watch', 'photo', 'photo.php', 'story.php', 'permalink.php',
  'hashtag', 'help', 'policies', 'privacy', 'legal', 'ads', 'business', 'profile.php']);

// -> https://facebook.com/<page>, keeping profile.php?id=… and pages/groups paths
export function normFacebook(raw) {
  if (!raw) return null;
  const s = decodeEntities(String(raw)).replace(ZERO_WIDTH, '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:[a-z-]+\.)?(?:facebook|fb)\.com\/(.+)$/i);
  if (!m) return null;
  const pid = m[1].match(/^profile\.php\?(?:[^#]*&)?id=(\d+)/i);
  if (pid) return 'https://facebook.com/profile.php?id=' + pid[1];
  const seg = m[1].split(/[?#]/)[0].replace(/\/+$/, '').split('/');
  const first = (seg[0] || '').toLowerCase();
  if (!first || FB_RESERVED.has(first) || BUILDER_HANDLES.has(first)) return null;
  // the old pg/<name>/about form is just the page <name>
  if (first === 'pg') return seg[1] && /^[A-Za-z0-9.-]{2,}$/.test(seg[1]) ? 'https://facebook.com/' + seg[1] : null;
  // pages/<name>/<id>, groups/<name>, people/<name>/<id>, p/<name-id>: the first segment alone is not a page
  if (['pages', 'groups', 'people', 'p'].includes(first)) {
    return seg[1] ? 'https://facebook.com/' + seg.slice(0, first === 'p' ? 2 : 3).join('/') : null;
  }
  if (!/^[A-Za-z0-9.-]{2,}$/.test(seg[0])) return null;
  return 'https://facebook.com/' + seg[0];
}

// --- HTML helpers ---
const hrefs = (html) => [...String(html).matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
  .map((m) => decodeEntities(m[1] ?? m[2]));
const textOf = (html) => decodeEntities(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ');
const section = (html, re) => (String(html).match(re) || [])[1] || '';
const firstOf = (arr, fn) => { for (const x of arr) { const v = fn(x); if (v) return v; } return null; };

// mailto: links first (in page order), then addresses written as text
function emailsIn(html) {
  const out = hrefs(html).filter((h) => /^mailto:/i.test(h.replace(ZERO_WIDTH, '').trim())).map(normEmail);
  for (const m of textOf(html).matchAll(EMAIL_IN_TEXT)) out.push(normEmail(m[0]));
  return uniq(out);
}

const result = (emails, website, instagram, facebook) => ({
  email: emails[0] || null, emails, website: website || null, instagram: instagram || null, facebook: facebook || null,
});

// --- Shortfilmdepot: GET /festivals/{Id}/fiche/{lang} ---
// Email is the festival's own; EmailContact is the submissions contact and falls
// back to help@shortfilmdepot.com when the festival left it empty.
export function parseSFDFiche(d = {}) {
  return result(uniq([normEmail(d.Email), normEmail(d.EmailContact)]),
    normWebsite(d.SiteWeb), normInstagram(d.UrlInstagram), normFacebook(d.UrlFacebook));
}

// --- Festagent: /en/festivals/<slug> ---
// Only the festival's contact sections are read. The page also carries the jury's
// personal emails ("Jury and Organizers"), Festagent's own footer email and
// Festagent's own social links — none of which belong to the festival.
export function parseFADetail(html) {
  const listed = section(html, /<p class="festival-contact-emails">([\s\S]*?)<\/p>/);
  const contacts = section(html, /<div class="contacts">([\s\S]*?)<\/div>/);
  const social = hrefs(section(html, /<p class="festival-social">([\s\S]*?)<\/p>/));
  return result(uniq([...emailsIn(listed), ...emailsIn(contacts)]),
    normWebsite(section(html, /<a[^>]*class="website"[^>]*href="([^"]*)"/)),
    firstOf(social, normInstagram), firstOf(social, normFacebook));
}

// --- Movibeta: props.project of /festivals/<id> ---
// No contact fields exist; organisers sometimes write them into the description.
// Takes ONLY descripcion + textoPortada — the project also holds email_paypal,
// which is a payment account, not a contact.
// A URL becomes the website only when an email on the same (non-freemail) domain
// vouches for it — then the site root is used, not the PDF under it — or when the
// text itself calls it the website. Anything else ("inscripcion.<festival>.com",
// a signup link nobody labels) is not a website.
export function parseMBDescription({ descripcion, textoPortada } = {}) {
  const html = [descripcion, textoPortada].filter(Boolean).join('\n');
  const emails = emailsIn(html);
  const text = textOf(html);
  const bare = text.match(/(?:https?:\/\/|www\.)[^\s"'<>()]+/gi) || [];
  const urls = uniq([...hrefs(html).filter((h) => !/^mailto:/i.test(h)), ...bare]);
  const ownDomains = emails.map((e) => e.split('@')[1]).filter((d) => !FREEMAIL.includes(d));

  let website = null;
  for (const raw of urls) {
    const u = normUrl(raw);
    const host = u && hostOf(u);
    if (!host || isPlatformOrSocial(host)) continue;
    if (ownDomains.some((d) => onDomain(host, d) || onDomain(d, host))) { website = new URL(u).origin + '/'; break; }
    const at = text.indexOf(raw);
    const before = at > 0 ? text.slice(Math.max(0, at - 40), at) : '';
    if (/\b(web ?site|web ?page|sitio web|página web|pagina web|site web|sito web|website)\s*[:(]?\s*$/i.test(before) && !isFileUrl(u)) {
      website = u; break;
    }
  }
  return result(emails, website, firstOf(urls, normInstagram), firstOf(urls, normFacebook));
}

// --- festival homepage (second hop) ---
// siteUrls: the listed website and the URL it redirected to (domains move:
// clermont-filmfest.com -> lecourt-clermont.org). Instagram and Facebook count only
// when exactly ONE distinct profile is linked; an email only when it's a mailto: on
// the site's own domain.
export function parseSiteSocials(html, siteUrls = []) {
  const links = hrefs(html);
  const handles = uniq(links.map(normInstagram));
  const pages = uniq(links.map(normFacebook));
  const hosts = uniq(siteUrls.map((u) => hostOf(normUrl(u) || '')));
  const emails = uniq(links.filter((h) => /^mailto:/i.test(h.trim())).map(normEmail))
    .filter((e) => hosts.some((h) => onDomain(h, e.split('@')[1]) || onDomain(e.split('@')[1], h)));
  return {
    email: emails[0] || null, emails,
    instagram: handles.length === 1 ? handles[0] : null,
    facebook: pages.length === 1 ? pages[0] : null,
  };
}

// --- is a homepage's account the festival's own? ---
// A homepage links whatever its owner chose — the organiser, the venue, a sponsor,
// a merch shop — and an expired domain now serving spam links anything at all
// ("Gathering" -> instagram.com/vavada.inst). So an account found on a homepage is
// kept only when its name visibly belongs to this festival:
//   - it contains a distinctive word of the festival's name, domain or email
//     ("lecourtclermont" on lecourt-clermont.org), or
//   - it carries the name's initials or a name word's first letters, next to a
//     film word ("the_emff", "sjiwff", "chifilmfest").
// Some real abbreviations fail ("adlfilmfest" for Adelaide) — dropped, not guessed.
const NAME_STOP = new Set(['film', 'films', 'festival', 'fest', 'international', 'internacional', 'internazionale',
  'short', 'shorts', 'cinema', 'cine', 'the', 'and', 'for', 'del', 'des', 'les', 'della', 'world', 'movie', 'movies',
  'award', 'awards', 'www', 'com', 'org', 'net', 'info', 'contact', 'hello', 'office', 'press', 'mail', 'admin',
  'submissions', 'programming', 'festivals', 'kino', 'video', 'documentary', 'animation', 'shortfilm',
  // function words, so initials are the name's ("Days of Ethnographic Film" -> "def")
  'of', 'de', 'la', 'el', 'le', 'du', 'di', 'da', 'do', 'in', 'on', 'at', 'en', 'et', 'y', 'e', 'i', 'a', 'al',
  'der', 'die', 'das', 'und', 'van', 'von', 'za', 'na', 'po', 'il', 'lo', 'los', 'las', 'dei', 'delle']);
const FILM_WORD = /film|fest|ff|cine|cin|doc|movie|ani|kino|short|curt|corto|screen/;
const accountName = (url) => {
  const ig = /^https:\/\/instagram\.com\/([a-z0-9._]+)$/.exec(url || '');
  if (ig) return ig[1];
  const fb = /^https:\/\/facebook\.com\/(?:(?:pages|groups|people|p)\/)?([^/?]+)/.exec(url || '');
  return fb && fb[1] !== 'profile.php' ? safeDecode(fb[1]) : null; // a numeric profile id says nothing
};
const words = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);

export function accountFits(url, { name, website, emails = [] } = {}) {
  const acct = accountName(url);
  if (!acct) return false;
  const full = acct.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const host = hostOf(normUrl(website) || '');
  const labels = host ? host.split('.').slice(0, -1).flatMap((l) => [l, ...l.split('-')]) : [];
  const own = (emails || []).flatMap((e) => {
    const [local, domain] = String(e).split('@');
    return [local, ...(FREEMAIL.includes(domain) ? [] : domain.split('.').slice(0, -1))];
  });
  const nameWords = words(name);
  const keyWords = nameWords.filter((w) => !NAME_STOP.has(w));
  const distinctive = [...nameWords, ...labels, ...own].map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 4 && !NAME_STOP.has(t));
  const allInitials = nameWords.map((w) => w[0]).join('');
  const keyInitials = keyWords.map((w) => w[0]).join('');
  // "thenyff", "real_k3filmfestival" — but "realefilmfestival" is Reale, so try both
  const variants = [full, full.replace(/^(the|real|official)/, '')];
  const joined = keyWords.join('');
  return variants.some((h) => {
    if (distinctive.some((t) => h.includes(t))) return true;
    if (joined.length >= 5 && h.includes(joined)) return true;                      // "Big Sky" -> "bigskydocumentaryfilmfest"
    if (keyWords.some((w) => w.length >= 3 && h.startsWith(w))) return true;         // "EKO …" -> "ekointernationalfilmfestival"
    if (h.length >= 8 && labels.some((l) => l.replace(/[^a-z0-9]/g, '').includes(h))) return true; // "cyprusfilmfest" on cyprusfilmfestival.org
    if (!FILM_WORD.test(h)) return false;
    if (allInitials.length >= 3 && h.includes(allInitials)) return true;            // "sjiwff", "liff" in "loveliff"
    if (keyInitials.length >= 2 && h.startsWith(keyInitials)) return true;          // "hc_film_fest", "the_emff"
    // a name word, or its first 3–5 letters, directly followed by a film word:
    // "chifilmfest", "butfilmfestival", "k3filmfestival" — but not "silkfest" for SILAFEST
    return keyWords.some((w) => {
      for (let k = Math.min(5, w.length); k >= Math.min(3, w.length); k--) {
        if ((k >= 3 || k === w.length) && h.startsWith(w.slice(0, k)) && FILM_WORD.test(h.slice(k, k + 5)) && /^(film|fest|ff|cine|cin|doc|ani|kino)/.test(h.slice(k))) return true;
      }
      return false;
    });
  });
}

// re-normalise a stored platform/match layer under the current rules
export function renormLayer(l) {
  if (!l || l.gone || l.error) return l;
  const emails = uniq((l.emails || (l.email ? [l.email] : [])).map(normEmail));
  return { ...l, email: normEmail(l.email) || emails[0] || null, emails, website: normWebsite(l.website),
    instagram: normInstagram(l.instagram), facebook: normFacebook(l.facebook) };
}

// re-check a homepage layer against its festival: accounts that don't fit move to
// `rejected` (kept for audit, never used), and every value is re-normalised, so
// stored layers follow the current rules without refetching
export function vetSiteLayer(site, festival) {
  if (!site || site.error) return site;
  const emails = uniq((site.emails || []).map(normEmail));
  const out = { email: emails[0] || null, emails, instagram: null, facebook: null };
  const rejected = {};
  for (const [f, norm] of [['instagram', normInstagram], ['facebook', normFacebook]]) {
    const v = norm(site[f] || (site.rejected && site.rejected[f]));
    if (!v) continue;
    if (accountFits(v, festival)) out[f] = v; else rejected[f] = v;
  }
  if (Object.keys(rejected).length) out.rejected = rejected;
  return out;
}

// --- name matching (Movibeta borrows from other catalogues) ---
// Exact match on a normalised name + the same country. Edition markers are dropped
// ("[EDICIÓN 2026]", "10º", "XVIII") because they change every year; nothing else is.
export function matchKey(name, country) {
  const tokens = decodeEntities(String(name || '')).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((t) => t && !/^\d+(st|nd|rd|th|a|o)?$/.test(t) && !/^[ivx]{1,6}$/.test(t));
  const c = String(country || '').trim().toLowerCase();
  return tokens.length && c ? tokens.join(' ') + '|' + c : null;
}

// candidates: [{ id, src, name, country, email, website, instagram, facebook }]
// A key that one catalogue uses for two festivals is ambiguous and never matches.
// Borrowed values pass the same normalisers as scraped ones: Festhome's sheet has
// corrupted handles ("instagram.com/noxfilfestival-viewer-location") and "www."
// or space-broken URLs that must not travel into another catalogue.
export function buildMatchIndex(candidates) {
  const byKey = new Map();
  for (const raw of candidates) {
    const k = matchKey(raw.name, raw.country);
    if (!k) continue;
    const c = { ...raw, email: normEmail(raw.email), website: normWebsite(raw.website),
      instagram: normInstagram(raw.instagram), facebook: normFacebook(raw.facebook) };
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  for (const [k, list] of byKey) {
    const perSrc = {};
    for (const c of list) perSrc[c.src] = (perSrc[c.src] || 0) + 1;
    if (Object.values(perSrc).some((n) => n > 1)) byKey.delete(k);
  }
  return byKey;
}

const MATCH_PRIORITY = ['sfd', 'fa', 'festhome']; // structured fields first

// -> { email, website, instagram, facebook, from: { field: record id } } or null
export function lookupMatch(index, name, country) {
  const list = index.get(matchKey(name, country));
  if (!list) return null;
  const sorted = [...list].sort((a, b) => MATCH_PRIORITY.indexOf(a.src) - MATCH_PRIORITY.indexOf(b.src));
  const out = { email: null, website: null, instagram: null, facebook: null, from: {} };
  for (const f of ['email', 'website', 'instagram', 'facebook']) {
    const hit = sorted.find((c) => c[f]);
    if (hit) { out[f] = hit[f]; out.from[f] = hit.id; }
  }
  return Object.keys(out.from).length ? out : null;
}

// layers in priority order: [['platform', parsed], ['website', parsed], ['match', parsed]]
// -> first non-empty value per field, with where each came from
export function combineContacts(layers) {
  const out = { email: null, emails: [], website: null, instagram: null, facebook: null, via: {} };
  for (const [name, l] of layers) {
    if (!l || l.error) continue;
    const via = (f) => (name === 'match' && l.from && l.from[f] ? 'match:' + l.from[f] : name);
    for (const f of ['email', 'website', 'instagram', 'facebook']) {
      if (!out[f] && l[f]) { out[f] = l[f]; out.via[f] = via(f); }
    }
    out.emails = uniq([...out.emails, ...(l.emails || (l.email ? [l.email] : []))]);
  }
  return out;
}

// merge cached contacts onto a map record. The cache is authoritative once it has
// the festival (a value it dropped must not survive a re-patch); only the website
// falls back to the record's own, since Festagent's list page already carries one.
export function applyContacts(rec, cache) {
  const c = cache && cache[rec.id];
  if (!c) return { ...rec, email: rec.email || null, website: rec.website || null, instagram: rec.instagram || null, facebook: rec.facebook || null };
  return { ...rec, email: c.email || null, website: c.website || rec.website || null, instagram: c.instagram || null, facebook: c.facebook || null };
}
