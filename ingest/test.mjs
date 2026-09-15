// Deterministic parser tests against committed fixtures.
//   fixtures/sample.csv     -> fixtures/expected.json      (Festhome parseRows)
//   fixtures/ff-sample.csv  -> fixtures/ff-expected.json   (FilmFreeway parseFFRows)
//   fixtures/sfd-sample.json-> fixtures/sfd-expected.json  (Shortfilmdepot parseSFDRows)
// Guards parse + CSV logic against regressions. Run: npm run test:ingest
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseRows, parseFFRows, parseSFDRows } from './parse.mjs';

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

// Shortfilmdepot ships as JSON (API response), not CSV. The sample bundles the
// /pays/dico slice it needs so the parser stays pure. Cases covered: country
// suffix stripping, country casing, a results-notification-only festival (must
// NOT become a deadline), a festival with no competitions, and a missing city.
const sfd = JSON.parse(read('fixtures/sfd-sample.json'));
const sfdCountries = Object.fromEntries(sfd.countries.map((p) => [p.Id, p.Libelle]));
check('shortfilmdepot', parseSFDRows(sfd.festivals, sfdCountries), JSON.parse(read('fixtures/sfd-expected.json')));

process.exit(failed ? 1 : 0);
