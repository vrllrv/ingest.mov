// End-to-end test of the public-CSV path: parseCsv -> parseRows, diffed
// against the known-good data.json. Fixture (/tmp/ff_export.csv) mirrors the
// sheet's real display formats (incl. abbreviated months & quoted addresses).
// Run: node ingest/test-csv.mjs
import fs from 'node:fs';
import { parseCsv, parseRows } from './parse.mjs';

const csv = fs.readFileSync('/tmp/ff_export.csv', 'utf8');
const expected = JSON.parse(fs.readFileSync('public/fest-map/data.json', 'utf8'));
const expById = new Map(expected.map((d) => [d.id, d]));

const values = parseCsv(csv);
const got = parseRows(values, '2026-05-31');
const FIELDS = ['name', 'country', 'cats', 'start', 'end', 'deadline', 'opens', 'status', 'url', 'inactive', 'warn'];

let diffs = 0;
const perField = {};
for (const rec of got) {
  const exp = expById.get(rec.id);
  if (!exp) { console.log('UNEXPECTED id', rec.id); diffs++; continue; }
  for (const f of FIELDS) {
    const a = JSON.stringify(exp[f] ?? (f === 'warn' ? [] : null));
    const b = JSON.stringify(rec[f] ?? (f === 'warn' ? [] : null));
    if (a !== b) {
      perField[f] = (perField[f] || 0) + 1;
      if (perField[f] <= 3) console.log(`id ${rec.id} [${f}] expected=${a} got=${b}`);
      diffs++;
    }
  }
}
console.log(`\nparsed rows: ${got.length}  total field diffs: ${diffs}`);
console.log('per-field:', perField);
process.exit(diffs === 0 && got.length === expected.length ? 0 : 1);
