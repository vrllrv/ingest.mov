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

// values: array-of-arrays from Sheets API (row 0 = header).
// todayISO: "YYYY-MM-DD" used to flag past events (compared lexically).
// Each record carries a transient `addr` (Full Address) for geocoding;
// the ingest strips it before writing data.json.
export function parseRows(values, todayISO) {
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

    // Festival Dates: "Start: <date> End: <date>", else "Opens …".
    const fd = g(row, 'Festival Dates');
    let start = null, end = null;
    const m = fd.match(/Start:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*End:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
    if (m) { start = parseDate(m[1]); end = parseDate(m[2]); }
    else if (/^opens/i.test(fd) && !opens) opens = fd;

    // "Opens …" text can live in Submission Deadline, Festival Dates, or
    // (in newer sheet rows) only in Status — use whichever carries it.
    if (!opens && /^opens/i.test(g(row, 'Status'))) opens = g(row, 'Status');

    // Derived flags (vs. the run date) — drive greying-out on the map.
    const warn = [];
    if (start && start < todayISO) warn.push('event date in the past');
    if (start && end && end < start) warn.push('end before start');

    out.push({
      id,
      name: g(row, 'Festival Name'),
      country: g(row, 'Country'),
      cats: g(row, 'Categories'),
      start, end, deadline, opens,
      status: g(row, 'Status'),
      url: g(row, 'URL'),
      inactive: warn.length > 0,
      warn,
      addr: g(row, 'Full Address'), // transient — stripped before write
    });
  }
  return out;
}
