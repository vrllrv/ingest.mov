// Validates parse.mjs against the known-good data.json using a fixture
// (/tmp/ff_values.json) generated from the live sheet. Run: node ingest/test-parse.mjs
import fs from 'node:fs';
import { parseRows } from './parse.mjs';

const values = JSON.parse(fs.readFileSync('/tmp/ff_values.json', 'utf8'));
const expected = JSON.parse(fs.readFileSync('public/fest-map/data.json', 'utf8'));
const expById = new Map(expected.map((d) => [d.id, d]));

const got = parseRows(values, '2026-05-31'); // GEN date the baked data used
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
console.log(`\nrecords: ${got.length}  total field diffs: ${diffs}`);
console.log('per-field:', perField);
process.exit(diffs === 0 ? 0 : 1);
