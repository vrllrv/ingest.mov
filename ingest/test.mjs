// Deterministic parser tests against committed fixtures.
//   fixtures/sample.csv     -> fixtures/expected.json      (Festhome parseRows)
//   fixtures/ff-sample.csv  -> fixtures/ff-expected.json   (FilmFreeway parseFFRows)
// Guards parse + CSV logic against regressions. Run: npm run test:ingest
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseRows, parseFFRows } from './parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let failed = 0;
function check(name, got, expected) {
  if (JSON.stringify(got, null, 2) === JSON.stringify(expected, null, 2)) {
    console.log(`ok — ${name}: ${got.length} records match fixture`);
    return;
  }
  failed++;
  console.error(`MISMATCH — ${name}:`);
  for (let i = 0; i < Math.max(got.length, expected.length); i++) {
    if (JSON.stringify(got[i]) !== JSON.stringify(expected[i])) {
      console.error('  at record', i);
      console.error('    got     ', JSON.stringify(got[i]));
      console.error('    expected', JSON.stringify(expected[i]));
      break;
    }
  }
}

check('festhome', parseRows(parseCsv(read('fixtures/sample.csv'))), JSON.parse(read('fixtures/expected.json')));
check('filmfreeway', parseFFRows(parseCsv(read('fixtures/ff-sample.csv'))), JSON.parse(read('fixtures/ff-expected.json')));

process.exit(failed ? 1 : 0);
