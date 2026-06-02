// Deterministic parser test against a committed fixture (fixtures/sample.csv
// → fixtures/expected.json), pinned to a fixed "today". Guards parse + CSV
// logic against regressions. Run: npm run test:ingest
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseRows } from './parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const csv = fs.readFileSync(path.join(HERE, 'fixtures/sample.csv'), 'utf8');
const expected = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/expected.json'), 'utf8'));

const got = parseRows(parseCsv(csv), '2026-06-02');
const a = JSON.stringify(got, null, 2);
const b = JSON.stringify(expected, null, 2);

if (a === b) {
  console.log(`ok — ${got.length} records match fixture`);
  process.exit(0);
}
// show first differing record
const ga = got, gb = expected;
for (let i = 0; i < Math.max(ga.length, gb.length); i++) {
  if (JSON.stringify(ga[i]) !== JSON.stringify(gb[i])) {
    console.error(`MISMATCH at record ${i}:`);
    console.error('  got     ', JSON.stringify(ga[i]));
    console.error('  expected', JSON.stringify(gb[i]));
    break;
  }
}
process.exit(1);
