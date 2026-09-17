// Deterministic parser tests against committed fixtures.
//   fixtures/sample.csv     -> fixtures/expected.json      (Festhome parseRows)
//   fixtures/ff-sample.csv  -> fixtures/ff-expected.json   (FilmFreeway parseFFRows)
//   fixtures/sfd-sample.json-> fixtures/sfd-expected.json  (Shortfilmdepot parseSFDRows)
//   fixtures/fa-sample.html -> fixtures/fa-expected.json   (Festagent parseFARows)
//   fixtures/mb-sample.json -> fixtures/mb-expected.json   (Movibeta parseMBRows)
//   fixtures/kw-cases.json  -> fixtures/kw-expected.json   (keyword panel, keywords-parse.mjs)
// Guards parse + CSV logic against regressions. Run: npm run test:ingest
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseRows, parseFFRows, parseSFDRows, parseFARows, parseMBRows } from './parse.mjs';
import { parseSFDFiche, parseFADetail, parseMBDescription, parseSiteSocials, buildMatchIndex, lookupMatch, accountFits } from './contacts-parse.mjs';
import {
  cleanKeyword, seedProblems, planJobs, dueQueue, spendable, requestFor, parseVolume, parseSuggestions, parseQuota,
  festivalStats, buildPanel, serializeCache, serializePanel,
} from './keywords-parse.mjs';

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

// Festagent ships as list-page HTML. Real rows, trimmed. Cases covered: sidebar
// blocks that share the row prefix, same-month / cross-month / cross-year ranges,
// a single day, "No data" dates, the 2100 rolling-deadline placeholder, closed and
// no-data deadline columns, a Cyrillic city, a multi-city list, a non-place city,
// a missing city, a "(Region)" qualifier, Macedonia, HTML entities, a repeated row.
check('festagent', parseFARows(read('fixtures/fa-sample.html')), JSON.parse(read('fixtures/fa-expected.json')));

// Movibeta ships as data-page JSON. The sample holds ONLY the fields the parser reads
// (raw rows also carry payment and webhook fields). Cases covered: Madrid midnight
// and 23:59, an Americas 23:59 (02:59Z), a mid-day time, a 23:00 Madrid deadline
// that must not read as Moscow midnight, festival dates defaulted to the deadline,
// unused price tiers, Spanish country names, the eligibility list in `pais`, missing
// countries, a "soon" state, a deactivated festival with no state, a repeated id.
const mb = JSON.parse(read('fixtures/mb-sample.json'));
check('movibeta', parseMBRows(mb.rows, mb.states), JSON.parse(read('fixtures/mb-expected.json')));

// Contacts (contacts-parse.mjs), all trimmed from real responses except the cases
// marked synthetic. Covered: help@shortfilmdepot.com fallback, scheme-less and
// "https://http://" URLs, profile.php, people/ and pg/ Facebook URLs; Festagent jury
// emails, footer email and zero-width spaces; Movibeta PDF links resolved to the site root, a
// labelled website, an unlabelled signup URL and "@" in a festival name; a Wix
// template's own Instagram, a redirected domain, two handles, post/share links;
// name matching across "@" spacing and edition markers, a corrupted borrowed handle,
// ambiguity, country, priority.
const cx = (name) => JSON.parse(read(`fixtures/${name}`));
const contactsExpected = cx('contacts-expected.json');
check('contacts: shortfilmdepot', cx('contacts-sfd.json').map((d) => [d.ShortName, parseSFDFiche(d)]), contactsExpected.sfd);
check('contacts: festagent', Object.entries(cx('contacts-fa.json')).map(([k, h]) => [k, parseFADetail(h)]), contactsExpected.fa);
check('contacts: movibeta', Object.entries(cx('contacts-mb.json')).map(([k, p]) => [k, parseMBDescription(p)]), contactsExpected.mb);
check('contacts: homepages', Object.entries(cx('contacts-site.json')).map(([k, s]) => [k, parseSiteSocials(s.html, s.urls)]), contactsExpected.site);
const matchFx = cx('contacts-match.json');
const matchIndex = buildMatchIndex(matchFx.candidates);
check('contacts: name match', matchFx.queries.map((q) => [q.case, lookupMatch(matchIndex, q.name, q.country)]), contactsExpected.match);
// Homepage accounts: kept only when they visibly belong to the festival. Real cases:
// abbreviations and domain names that fit; an expired domain's casino spam, a merch
// shop, a venue, a different festival, a sister festival, a personal profile and an
// unverifiable profile id that don't; and one real abbreviation knowingly lost.
check('contacts: homepage accounts', cx('contacts-accounts.json').cases.map((c) => [`${c.festival.name} -> ${c.account}`, accountFits(c.account, c.festival)]), contactsExpected.accounts);

// Keyword panel (keywords-parse.mjs). The API responses are SYNTHETIC, shaped as
// keywordtool.io/api documents them. Covered: keyword limits (80 chars, 10 words) and
// punctuation; a keyword under two languages of one set and in two sets; discovery on an
// unknown market; a flagged keyword in no set; fresh, stale, grown and never-run jobs in
// spending order; the quota floor; request bodies with and without a location; an accent
// the API drops, a keyword it omits, the API's no-data row (volume null, as seen live),
// string CPCs; suggestions repeated across groups and below the
// minimum; quota shapes that must NOT be read (minute-only, ambiguous); one festival on
// two platforms, Festhome's frozen status text, rolling / "Soon" / "Opens" calls, the
// 12-month window, no country; grouped variants counted once; a flagged keyword shown but
// not counted; an old cache row with null volume not counted as measured; seeds excluded
// from discovery candidates.
const kw = cx('kw-cases.json');
const kwExpected = cx('kw-expected.json');
const kwJobs = planJobs(kw.seeds);
check('keywords: clean', kw.clean.map((s) => [s, cleanKeyword(s)]), kwExpected.clean);
check('keywords: seed problems', seedProblems(kw.seeds), kwExpected.problems);
check('keywords: jobs', kwJobs.map((j) => [j.id, j.kind === 'volume' ? j.keywords : { head: j.head, type: j.type, cc: j.cc, lang: j.lang, tier: j.tier }]), kwExpected.jobs);
check('keywords: due queue', dueQueue(kwJobs, kw.cacheForQueue, Date.parse(kw.queueNow), 28).map((d) => [d.job.id, d.why]), kwExpected.queue);
check('keywords: spendable', kw.spendable.map(([b, f, r]) => [`budget ${b}, floor ${f}, remaining ${r}`, spendable(b, f, r ?? NaN)]), kwExpected.spendable);
check('keywords: requests', ['vol:br', 'vol:global', 'sug:br:suggestions:audiodescrição'].map((id) => {
  const j = kwJobs.find((x) => x.id === id);
  return [id, requestFor(j, kw.seeds.markets.find((m) => m.id === j.market))];
}), kwExpected.requests);
check('keywords: volume response', Object.entries(parseVolume(kw.volumeResponse, kw.volumeAsked)), kwExpected.volume);
check('keywords: suggestions response', Object.entries(parseSuggestions(kw.suggestionsResponse, 10)), kwExpected.suggestions);
check('keywords: quota', kw.quota.map(([name, j]) => [name, parseQuota(j)]), kwExpected.quota);
const kwFest = festivalStats(kw.rows, kw.today);
check('keywords: festival stats', [['total', kwFest.total], ...Object.entries(kwFest.byCountry), ['groups', kwFest.groups]], kwExpected.festivals);
const kwPanel = buildPanel({ seeds: kw.seeds, cache: kw.panelCache, rows: kw.rows, today: kw.today, now: Date.parse(kw.queueNow) });
check('keywords: panel', [['markets', kwPanel.markets], ['keywords br', kwPanel.keywords.br], ['candidates', kwPanel.candidates], ['progress', kwPanel.progress], ['dataMonth', kwPanel.dataMonth]], kwExpected.panel);
// the writers must round-trip: keys come back sorted, content unchanged
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
check('keywords: writers round-trip', [
  ['cache', JSON.stringify(sortKeys(JSON.parse(serializeCache(kw.panelCache)))) === JSON.stringify(sortKeys(kw.panelCache))],
  ['empty cache', JSON.stringify(JSON.parse(serializeCache({ jobs: {}, runs: [] })))],
  ['panel', JSON.stringify(JSON.parse(serializePanel(kwPanel))) === JSON.stringify(kwPanel)],
], [['cache', true], ['empty cache', '{"jobs":{},"runs":[]}'], ['panel', true]]);

process.exit(failed ? 1 : 0);
