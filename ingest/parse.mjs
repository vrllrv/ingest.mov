// Pure parser: Google Sheets "Future Festivals" rows -> map records.
// No I/O, no geocoding — kept side-effect free so it can be unit-tested
// against the known-good data.json (see test-parse.mjs).

const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, Jun: 6, Jul: 7, Aug: 8,
  Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12, // May has no abbreviation
};

// Minimal RFC-4180 CSV parser -> array of rows. Handles quoted fields with
// embedded commas, quotes ("") and newlines (as Google's CSV export emits).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const ymd = (d) => d.toISOString().slice(0, 10);

// Accepts: Date, ISO "YYYY-MM-DD", "DD Month YYYY", or a Google Sheets
// serial number (days since 1899-12-30). Returns ISO date string or null.
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return ymd(v);
  if (typeof v === 'number') return ymd(new Date(Date.UTC(1899, 11, 30) + v * 86400000));
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m && MONTHS[m[2]]) {
    return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

// FilmFreeway "FilmFreeway" tab (directory listing) -> records. The listing
// carries NO dates — festival/event dates are merged in the ingest from
// ingest/filmfreeway-dates.json (collected by tools/filmfreeway-scraper.user.js).
// Stable id is `ff:<url-slug>` (slugs are unique). `addr` is transient (geocode).
export function parseFFRows(values) {
  const hdr = values[0].map((h) => String(h).trim());
  const idx = Object.fromEntries(hdr.map((h, i) => [h, i]));
  const g = (row, h) => (idx[h] != null && row[idx[h]] != null ? String(row[idx[h]]).trim() : '');

  const out = [];
  const seen = new Set();
  for (const row of values.slice(1)) {
    const url = g(row, 'URL');
    if (!url) continue;
    const slug = url.replace(/\/+$/, '').split('/').pop().split('?')[0];
    if (!slug || seen.has(slug)) continue; // de-dupe by slug
    seen.add(slug);

    const yearsRaw = g(row, 'Years Running');
    const loc = g(row, 'Location');
    out.push({
      id: 'ff:' + slug,
      slug,
      name: g(row, 'Festival Name'),
      country: g(row, 'Country'),
      location: loc || null,
      years: /^\d+$/.test(yearsRaw) ? Number(yearsRaw) : null,
      status: g(row, 'Entry Status') || null, // Open | Closed
      badges: g(row, 'Badges').split('|').map((b) => b.trim()).filter(Boolean),
      url,
      addr: loc, // transient — stripped before write
    });
  }
  return out;
}

// values: array-of-arrays from Sheets API (row 0 = header).
// Each record carries a transient `addr` (Full Address) for geocoding;
// the ingest strips it before writing data.json.
export function parseRows(values) {
  const hdr = values[0].map((h) => String(h).trim());
  const idx = Object.fromEntries(hdr.map((h, i) => [h, i]));
  const g = (row, h) => (idx[h] != null && row[idx[h]] != null ? String(row[idx[h]]).trim() : '');

  const out = [];
  for (const row of values.slice(1)) {
    const idCell = row[idx['Festival ID']];
    if (idCell == null || idCell === '') continue;
    const id = Math.round(Number(idCell));

    // Submission Deadline: a real date -> deadline; "Opens …" text -> opens.
    const sd = g(row, 'Submission Deadline');
    let opens = null, deadline = null;
    if (/^opens/i.test(sd)) opens = sd;
    else deadline = parseDate(row[idx['Submission Deadline']]);

    // Festival Dates: prefer "Start: <date> End: <date>"; also tolerate a plain
    // range ("18 November 2026 - 31 December 2026") or a single date, so the map
    // still gets dates if the sheet's format ever drifts. "Opens …" is not a date.
    const fd = g(row, 'Festival Dates');
    let start = null, end = null;
    const DATE = /\d{1,2}\s+[A-Za-z]+\s+\d{4}/g;
    const m = fd.match(/Start:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*End:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
    if (m) { start = parseDate(m[1]); end = parseDate(m[2]); }
    else if (/^opens/i.test(fd)) { if (!opens) opens = fd; }
    else { const ds = fd.match(DATE); if (ds && ds.length) { start = parseDate(ds[0]); end = parseDate(ds[ds.length - 1]); } }

    // "Opens …" text can live in Submission Deadline, Festival Dates, or
    // (in newer sheet rows) only in Status — use whichever carries it.
    if (!opens && /^opens/i.test(g(row, 'Status'))) opens = g(row, 'Status');

    // Data-integrity flags only. "Past event" greying is computed live on the
    // map (end-date based, vs. the user's selected timezone), not baked here.
    const warn = [];
    if (start && end && end < start) warn.push('end before start');

    out.push({
      id,
      name: g(row, 'Festival Name'),
      country: g(row, 'Country'),
      cats: g(row, 'Categories'),
      start, end, deadline, opens,
      status: g(row, 'Status'),
      url: g(row, 'URL'),
      email: g(row, 'Email') || null,
      website: g(row, 'Website') || null,
      instagram: g(row, 'Instagram') || null,
      facebook: g(row, 'Facebook') || null,
      inactive: warn.length > 0,
      warn,
      addr: g(row, 'Full Address'), // transient — stripped before write
    });
  }
  return out;
}

// Shortfilmdepot's public JSON API returns the whole catalogue in one anonymous
// POST, so unlike FilmFreeway this source needs no browser scraping.
//
// Naming gotcha: despite "Campagne", DebutCampagne/FinCampagne are the FESTIVAL's
// own event dates — median span 5 days, and they match the dates festivals quote
// in their own descriptions. They are NOT the submission window; submission dates
// live in Competitions[].NextEvent.

// SFD's country table carries sub-region suffixes ("United Kingdom, England") and
// inconsistent casing ("Czech republic"). Left as-is each would become its own
// entry in the map's country dropdown, splitting one country across several rows.
const SFD_COUNTRY_FIX = {
  'United States of America': 'United States', // the vocabulary the other two sources use
  'United kingdom': 'United Kingdom',
  'Czech republic': 'Czech Republic',
  'Burkina faso': 'Burkina Faso',
};

export function normalizeSFDCountry(raw) {
  if (!raw) return '';
  const head = String(raw).split(',')[0].trim(); // "United Kingdom, England" -> "United Kingdom"
  return SFD_COUNTRY_FIX[head] || head;
}

// NextEvent.IdEvent: 1 = opening submissions, 2 = final deadline, 9 = extended
// deadline, 3 = notification of results. Results notifications are deliberately
// NOT treated as deadlines — 96 of them exist, and using them would show a results
// date where the map promises a submission cutoff.
const SFD_DEADLINE_EVENTS = new Set([2, 9]);
const SFD_OPENING_EVENT = 1;

const sfdDay = (v) => (v ? String(v).slice(0, 10) : null); // "2027-01-29T00:00:00" -> "2027-01-29"

// list: parsed JSON array from POST /festivals/filter/{skip}/{take}
// countryById: IdPays -> country name, from GET /pays/dico
export function parseSFDRows(list, countryById = {}) {
  const out = [];
  const seen = new Set();
  for (const f of list || []) {
    const slug = f.ShortName;
    if (!slug || seen.has(slug)) continue; // de-dupe by slug
    seen.add(slug);

    const comps = f.Competitions || [];
    const live = comps.map((c) => c.NextEvent).filter((e) => e && e.DateEvent && !e.HasExpired);
    // earliest matching event wins, so a festival with several competitions
    // surfaces the deadline the user actually has to hit first
    const earliest = (test) => live.filter(test).map((e) => sfdDay(e.DateEvent)).sort()[0] || null;

    const start = sfdDay(f.DebutCampagne);
    const end = sfdDay(f.FinCampagne);

    const prices = comps.flatMap((c) => [c.PrixMin, c.PrixMax]).filter((p) => p != null);
    const country = normalizeSFDCountry(countryById[f.IdPays]);
    const city = String(f.Ville || '').trim();

    const warn = [];
    if (start && end && end < start) warn.push('end before start');

    out.push({
      id: 'sfd:' + slug,
      src: 'sfd',
      name: String(f.Nom || '').trim(),
      country,
      location: city || null,
      start,
      end,
      deadline: earliest((e) => SFD_DEADLINE_EVENTS.has(e.IdEvent)),
      opens: earliest((e) => e.IdEvent === SFD_OPENING_EVENT),
      status: f.IsOpen ? 'Open' : 'Closed',
      comps: comps.length,
      feeMin: prices.length ? Math.min(...prices) : null,
      feeMax: prices.length ? Math.max(...prices) : null,
      url: 'https://shortfilmdepot.com/en/festival/' + slug,
      slug,
      inactive: warn.length > 0,
      warn,
      hasDates: !!start,
      addr: [city, country].filter(Boolean).join(', '), // transient — stripped before write
    });
  }
  return out;
}

// Festagent's festival directory is server-rendered HTML: /en/festivals?page=N,
// 30 rows a page, and every row already carries what the map needs (event dates,
// country, city, deadline) — so the ingest reads the list pages, never the ~1,500
// detail pages. Reuse condition from their footer: "You may use information from
// this website only if a link to the source is provided" — every popup links back.

const decodeEntities = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const FA_COUNTRY_FIX = {
  Macedonia: 'North Macedonia', // the vocabulary the other sources use
};

const iso = (y, mon, d) => `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// "Event Dates:" text. Formats seen across the whole catalogue:
//   "1 — 3 December 2026"            same month
//   "29 January — 6 February 2027"   year only on the end
//   "21 November 2025 — 29 November 2026"
//   "23 October 2026"                single day
//   "No data"
// A range crossing New Year without a start year ("28 December — 3 January 2027")
// starts the year before; none exist today, but the listing format allows it.
export function parseFADates(raw) {
  const s = decodeEntities(raw || '').replace(/^\s*Event Dates:\s*/i, '').replace(/\s+/g, ' ').trim();
  let m = s.match(/^(\d{1,2})(?: ([A-Za-z]+))?(?: (\d{4}))? — (\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if (m && MONTHS[m[5]] && (!m[2] || MONTHS[m[2]])) {
    const endMon = MONTHS[m[5]], endYear = Number(m[6]);
    const startMon = m[2] ? MONTHS[m[2]] : endMon;
    const startYear = m[3] ? Number(m[3]) : startMon > endMon ? endYear - 1 : endYear;
    return { start: iso(startYear, startMon, m[1]), end: iso(endYear, endMon, m[4]) };
  }
  const one = parseDate(s); // "23 October 2026"
  return { start: one, end: one };
}

// Deadline column: "September 24, 2026" while submissions are open, otherwise
// "The submission period is over." or "No data." — which is also how the row's
// status is known. Year 2100 is a "rolling / no deadline" placeholder, not a date.
function parseFADeadline(raw) {
  const m = String(raw || '').replace(/\s+/g, ' ').trim().match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (!m || !MONTHS[m[1]] || Number(m[3]) >= 2100) return null;
  return iso(m[3], MONTHS[m[1]], m[2]);
}

// The first place in the city cell. Cells hold lists ("Moscow, St. Petersburg,
// Penza and Vladimir."), qualifiers ("Santarcangelo di Romagna (Rimini)"), whole
// sentences and non-places ("2025-2026-..."); Nominatim wants one place, and
// geocode() falls back to the country when even that misses.
const faCity = (city) => {
  const first = city.split(/,|;|\(| and /)[0].replace(/\.+$/, '').trim();
  return /\p{L}/u.test(first) ? first : '';
};

// pages: HTML strings of /en/festivals?page=N, in page order
export function parseFARows(pages) {
  const out = [];
  const seen = new Set();
  for (const html of [].concat(pages || [])) {
    // each row opens with <div class="festival " id="<slug>">. The sidebar reuses
    // the prefix (festival-counter-tooltip, festival-list-countries) but those have
    // no title link, so the name check below drops them.
    for (const block of String(html).split(/<div class="festival[^"]*"\s+id="/).slice(1)) {
      const pick = (re) => { const m = block.match(re); return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''; };
      const slug = block.slice(0, block.indexOf('"'));
      const name = pick(/class="title-link">\s*<a[^>]*>(?:\s*<img[^>]*>)?([\s\S]*?)<\/a>/);
      // the list is deadline-sorted and can shift mid-crawl, so a row may repeat
      if (!slug || !name || seen.has(slug)) continue;
      seen.add(slug);

      const { start, end } = parseFADates(pick(/festival-dates">([\s\S]*?)<\/p>/));
      // any date in the deadline column means open — including the 2100 placeholder,
      // which is a rolling call with no cutoff rather than a closed one
      const deadlineText = pick(/class="text-gray deadline">([\s\S]*?)<\/small>/);
      const deadline = parseFADeadline(deadlineText);
      const deadlineCol = pick(/deadline-column">([\s\S]*?)<\/div>/).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const status = deadlineText ? 'Open' : /submission period is over/i.test(deadlineCol) ? 'Closed' : null;

      const rawCountry = pick(/class="country-icon[^"]*"><\/span>([^<]*)/);
      const country = FA_COUNTRY_FIX[rawCountry] || rawCountry;
      const city = pick(/festival-city">([^<]*)</);
      const years = pick(/<div class="small text-gray">\s*(\d+) years?\s*<\/div>/);

      const warn = [];
      if (start && end && end < start) warn.push('end before start');

      out.push({
        id: 'fa:' + slug,
        src: 'fa',
        name,
        country,
        location: /\p{L}/u.test(city) ? city : null, // "2025-2026-..." is not a place
        start,
        end,
        deadline,
        opens: null, // the list page has no opening date
        status,
        years: years ? Number(years) : null,
        free: /festival-label-free"/.test(block),
        website: pick(/festival-website">\s*<a[^>]*href="([^"]*)"/) || null,
        url: 'https://festagent.com/en/festivals/' + slug,
        slug,
        inactive: warn.length > 0,
        warn,
        hasDates: !!start,
        // transient — stripped before write. Empty without a city: a bare country here
        // would be cached as a city-precision hit; geocode() places it on the country.
        addr: faCity(city) ? [faCity(city), country].filter(Boolean).join(', ') : '',
      });
    }
  }
  return out;
}

// Movibeta is a Laravel + Inertia.js app: /festivals?page=N is an HTML shell whose
// data-page attribute holds the page's full props as HTML-escaped JSON, 30 festivals
// a page (~25 pages). No API key, no cookie.
//
// Raw rows also carry fields that must never be stored (email_paypal, merchantId,
// webhook_token, user_id…). parseMBRows reads only the fields named below, and the
// committed fixture holds only those.

// data-page JSON from one list page -> { rows, states, lastPage }
export function parseMBPage(html) {
  const m = String(html).match(/data-page="([^"]*)"/);
  if (!m) throw new Error('movibeta: no data-page attribute — not an Inertia page any more?');
  const { props } = JSON.parse(decodeEntities(m[1]));
  const pg = props && props.paginator;
  if (!pg || !Array.isArray(pg.data)) throw new Error('movibeta: data-page has no paginator.data');
  return {
    rows: pg.data,
    // the open/closed state lives only in the parallel `projects` list, keyed by id
    states: Object.fromEntries((props.projects || []).map((p) => [p.id, p.estado])),
    lastPage: Number(pg.last_page) || 1,
  };
}

// paisOrigen mixes English and Spanish names for the same country
const MB_COUNTRY_FIX = {
  'España': 'Spain', 'México': 'Mexico', 'Italia': 'Italy', 'Brasil': 'Brazil',
  'Panamá': 'Panama', 'Perú': 'Peru', 'Alemania': 'Germany', 'Marruecos': 'Morocco',
  'Turquía': 'Turkey', 'Reino Unido': 'United Kingdom',
  'Russian Federation': 'Russia', // the spelling most rows in the other sources use
};

// Dates are stored as UTC instants of a LOCAL midnight or 23:59, in the festival's
// own timezone, which isn't stored: 22:00Z is midnight in Madrid, 03:00Z midnight in
// Buenos Aires, 02:59Z is 23:59 the day before in Buenos Aires. Neither slicing the
// UTC string nor converting to Madrid gets all of them right. So: find the offset in
// Movibeta's markets (UTC-6 Americas … UTC+2 Madrid summer) that makes the instant a
// round 00:00 or 23:59, and take that local date. Anything else ("19:00Z", or
// "21:00Z" = 23:00 in Madrid) is read as CET. The window stops at +2 on purpose:
// the few Russian festivals are stored in Madrid time too, and +3 would turn
// Spain's 23:00 deadlines into Moscow midnight, a day late.
function mbDay(v) {
  const t = Date.parse(v);
  if (!v || Number.isNaN(t)) return null;
  for (let h = -6; h <= 2; h++) {
    const local = new Date(t + h * 3600e3).toISOString();
    const hm = local.slice(11, 16);
    if (hm === '00:00' || hm === '23:59') return local.slice(0, 10);
  }
  return new Date(t + 3600e3).toISOString().slice(0, 10);
}

// estado from the projects list. "soon" = submissions not open yet.
const MB_STATUS = {
  'project-state-open': 'Open',
  'project-state-last-days': 'Open',
  'project-state-soon': 'Soon',
  'project-state-closed': 'Closed',
  'project-state-closed-projection': 'Closed',
};

// rows: paginator.data from every page, in page order
// states: id -> estado, merged from every page's projects list
export function parseMBRows(rows, states = {}) {
  const out = [];
  const seen = new Set();
  for (const f of rows || []) {
    // the list is deadline-sorted and shifts between page fetches, so ids repeat
    if (f.id == null || seen.has(f.id)) continue;
    seen.add(f.id);

    const deadline = mbDay(f.fechaFinSubida);
    // fechaCelebracion is the festival date, but the form defaults it to the
    // deadline: 257 of 741 rows are exactly equal, 145 more land within a day of it.
    // A festival held on or before its own submission deadline is that default, not
    // a date, so it's treated as unknown.
    const cel = mbDay(f.fechaCelebracion);
    const start = cel && (!deadline || cel > deadline) ? cel : null;
    // `pais` is NOT the location — it's the list of countries eligible to submit
    // ("Argentina__Bolivia__…"). paisOrigen is where the festival is.
    const rawCountry = String(f.paisOrigen || '').trim();
    const country = MB_COUNTRY_FIX[rawCountry] || rawCountry;
    // deactivated festivals are left out of the projects list, so they have no estado
    const status = MB_STATUS[states[f.id]] || (f.active === false ? 'Closed' : null);
    // fee, fee1..fee3 are price tiers, each with its own feeNDesde start date. An
    // unused tier is stored as 0 with no start date — counting it would make a paid
    // festival look free. No usable tier at all is how free festivals are stored.
    const tiers = [[f.fee, f.feeDesde], [f.fee1, f.fee1Desde], [f.fee2, f.fee2Desde], [f.fee3, f.fee3Desde]]
      .filter(([v, from]) => from || Number(v) > 0).map(([v]) => Number(v)).filter(Number.isFinite);
    const fees = tiers.length ? tiers : [0];

    out.push({
      id: 'mb:' + f.id,
      src: 'mb',
      name: decodeEntities(f.nombre || '').replace(/\s+/g, ' ').trim(),
      country,
      location: null, // Movibeta has no city field
      start,
      end: null, // fechaFinProyeccion is the end of online screening, not the festival
      deadline,
      opens: mbDay(f.fechaInicio),
      status,
      feeMin: fees.length ? Math.min(...fees) : null,
      feeMax: fees.length ? Math.max(...fees) : null,
      qualifying: !!f.goyaOscar, // Goya / Oscar qualifying
      url: 'https://www.movibeta.com/festivals/' + f.id,
      slug: String(f.id),
      inactive: false,
      warn: [],
      hasDates: !!start,
      // no city: geocode() places it on the country, flagged prec 'country'
      addr: '', // transient — stripped before write
    });
  }
  return out;
}
