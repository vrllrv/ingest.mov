# fest-map data ingest

Pulls the **"Future Festivals"** Google Sheet tab (public, CSV) → parses dates →
geocodes addresses → writes [`../public/fest-map/data.json`](../public/fest-map/data.json),
which the map fetches at runtime. Runs weekly (Mondays 12:00 UTC, plus on demand) via
[`.github/workflows/refresh-festmap.yml`](../.github/workflows/refresh-festmap.yml).

```
Festhome → (sheet's Apps Script auto-pull) → Future Festivals tab
   → ingest.mjs: parse + geocode (cached) → data.json → wrangler deploy
```

Deploys happen two ways: `deploy.yml` on every push to `main`, and
`refresh-festmap.yml` on its weekly cron (which also commits the refreshed data
back). Both run `npm run ingest` first — `public/fest-map/meta.json` is gitignored
but deployed, so deploying without regenerating it would strip it from production.

Only the **`Future Festivals`** tab is read. `Sheet1` (raw/past festivals) is ignored.
No Google credentials are used — the sheet holds only public Festhome data and is
read via its public CSV export.

## Sources

The map carries five catalogues, each written to its own file and switched on or
off independently in the UI. **No source needs credentials.**

| Source | Key | Where the data comes from | Output |
|--------|-----|---------------------------|--------|
| Festhome | `festhome` | `Future Festivals` sheet tab (public CSV) | `data.json` |
| FilmFreeway | `ff` | `FilmFreeway` sheet tab + browser-scraped `filmfreeway-dates.json` | `data-ff.json` |
| Shortfilmdepot | `sfd` | the site's own public JSON API | `data-sfd.json` |
| Festagent | `fa` | server-rendered festival list pages | `data-fa.json` |
| Movibeta | `mb` | `data-page` JSON embedded in its list pages | `data-mb.json` |

### Shortfilmdepot

`apiv3-user.shortfilmdepot.com` serves the whole catalogue (~219 festivals) in one
anonymous `POST /festivals/filter/0/{take}`, plus `GET /pays/dico` for the country
lookup. No key and no cookie: the site's own front end calls it the same way. CORS
hides this from a browser, but CORS does not apply server-side.

Two things that are easy to get wrong:

- **`skip`/`take` go in the request BODY.** Passing them only in the URL path returns
  a single row, silently.
- **`DebutCampagne`/`FinCampagne` are the FESTIVAL's dates, not the submission
  window** — despite the name. Median span is 5 days and they match the dates
  festivals quote in their own descriptions. Submission dates live in
  `Competitions[].NextEvent`, where `IdEvent` 2/9 are real deadlines, 1 is "opening
  submissions", and **3 is "notification of results" — deliberately not treated as a
  deadline**, or the map would show a results date as a submission cutoff.

SFD's country table carries sub-region suffixes (`"United Kingdom, England"`) and
inconsistent casing (`"Czech republic"`); `normalizeSFDCountry()` folds these onto
the vocabulary the other sources use, so one country stays one entry in the map's
country dropdown.

It is an undocumented internal API: the ingest sends an identifying User-Agent and
makes exactly two calls per run. Override the host with `SFD_API` if it moves.

### Festagent

`festagent.com/en/festivals?page=N` is plain server-rendered HTML, 30 rows a page
(~51 pages, ~1,500 festivals). Each row already carries event dates, country, city
and deadline, so the ingest reads only the list pages — one a second — and never
the detail pages. It walks pages until one comes back without rows.

**Reuse condition.** Festagent's footer: *"You may use information from this website
only if a link to the source is provided."* Every Festagent popup links to the
festival's Festagent page; keep it that way.

Things that are easy to get wrong:

- **The row prefix is shared.** Rows open with `<div class="festival " id="<slug>">`,
  but so do sidebar blocks (`festival-counter-tooltip`, `festival-list-countries`).
  Only blocks with a title link are festivals.
- **Status comes from the deadline column.** A date there means open; `The submission
  period is over.` means closed; `No data.` (old editions) leaves status empty.
- **`October 13, 2100` is a placeholder** for a call with no cutoff. It stays open,
  with no deadline, and the popup says "rolling".
- **Only the end of a range carries the year** (`29 January — 6 February 2027`). A
  range whose start month is later than its end month starts the year before.
- **The city cell is free text:** lists (`Moscow, St. Petersburg, …`), qualifiers
  (`Santarcangelo di Romagna (Rimini)`), Cyrillic, and non-places (`2025-2026-...`).
  The first place is geocoded and `geocode()` falls back to the country; the full
  text is kept as `location` for the popup.
- The list is sorted by deadline and can shift while it's being crawled, so rows
  are de-duplicated by slug.

Override the host with `FA_BASE` if it moves.

### Movibeta

Movibeta is a Laravel + Inertia.js app. `movibeta.com/festivals?page=N` is an HTML
shell whose `data-page` attribute holds the page's props as HTML-escaped JSON: 30
festivals in `props.paginator.data` (~25 pages, ~740 festivals), plus
`paginator.last_page`. No key, no cookie. One page a second.

**Raw rows carry fields that must never be stored**: `email_paypal`, `merchantId`,
`webhook_token`, `user_id` and others. They stay in `buildMovibeta()`'s memory;
`parseMBRows()` reads a fixed set of fields, and `fixtures/mb-sample.json` holds
only those. Keep it that way when refreshing the fixture.

Things that are easy to get wrong:

- **`pais` is not the location.** It's the list of countries *eligible to submit*
  (`"Argentina__Bolivia__…"`). The festival's own country is `paisOrigen`, which mixes
  English and Spanish (`España`, `México`, `Reino Unido`…); `MB_COUNTRY_FIX` folds them.
- **There is no city field**, so every Movibeta pin sits on its country
  (`prec: 'country'`, flagged in the popup). ~22 rows have no country at all and
  don't appear on the map.
- **Dates are local midnights / 23:59s stored as UTC, in an unstored timezone.**
  `22:00Z` is midnight in Madrid, `03:00Z` midnight in Buenos Aires, `02:59Z` is 23:59
  the day before in Buenos Aires. Slicing the string or converting to Madrid both
  get some wrong. `mbDay()` picks the offset between UTC−6 and UTC+2 that makes the
  instant a round 00:00 or 23:59, and reads anything else as CET. The window stops
  at +2 on purpose: `21:00Z` deadlines are 23:00 in Madrid, not Moscow midnight.
- **`fechaCelebracion` (festival date) defaults to the deadline.** 257 of 741 rows
  are exactly equal and 145 more land within a day. A festival date on or before
  its own deadline is treated as unknown.
- **`fechaFinProyeccion` is not the festival's end** (it's the end of online
  screening, often before the festival), so `end` stays empty.
- **Unused price tiers are stored as `0`.** A tier counts only with a start date
  (`feeNDesde`) or a non-zero price; no counting tier means free.
- **Open/closed state isn't in the row**: it's `estado` in the parallel
  `props.projects` list, joined by id. Deactivated festivals are missing from that
  list and are marked closed.
- The list shifts between page fetches, so ids repeat and are de-duplicated.

Override the host with `MB_BASE` if it moves.

## Contacts (email, website, Instagram, Facebook)

Festhome's sheet already carries contacts. For Shortfilmdepot, Festagent and
Movibeta, `contacts.mjs` collects them into `contacts.json`, and the ingest merges
that file into `data-{sfd,fa,mb}.json`. **The ingest never scrapes contacts**, so a
deploy stays fast. Accuracy over coverage: every value is normalised, and anything
ambiguous is dropped rather than guessed.

```bash
npm run contacts                         # everything never fetched or older than 180 days (~45 min for all)
npm run contacts -- --only-new           # only festivals not in contacts.json yet
npm run contacts -- --budget 150         # at most 150 platform requests (the weekly CI run)
npm run contacts -- --sources fa --no-websites
```

It paces itself (one request a second per platform, the three in parallel; homepages
a few hosts at a time, `robots.txt` respected) and saves progress as it goes: stop
it any time and re-run to resume. It reads the catalogue from `data-*.json`, so run
the ingest first; it patches those files' contact fields when done.

Where each value comes from, in priority order, recorded per field in `via`:

1. **platform**, the catalogue's own page:
   - Shortfilmdepot `GET /festivals/{Id}/fiche/en`: `Email`, then `EmailContact`, `SiteWeb`, `UrlInstagram`, `UrlFacebook`.
   - Festagent's detail page, **only** its `a.website`, `div.contacts`, `p.festival-contact-emails` and `p.festival-social`.
   - Movibeta: no contact fields; addresses and links organisers wrote into the description.
2. **website**: the festival's homepage, for festivals still missing Instagram or email.
3. **match:<id>** (Movibeta only): the same festival in Festhome, Shortfilmdepot or Festagent.

Things that are easy to get wrong:

- **Platform addresses sit next to festival ones.** Shortfilmdepot fills an empty
  `EmailContact` with `help@shortfilmdepot.com`; every Festagent page has
  `hello@festagent.com` in its footer. Platform domains are never stored.
- **Festagent pages hold personal emails** in "Jury and Organizers". Only the contact
  sections are read.
- **Movibeta's project has `email_paypal`**: a payment account, never a contact. The
  parser only ever receives `descripcion` and `textoPortada`. A description URL counts as
  the website only when an email on the same (non-freemail) domain vouches for it, or
  the text calls it the website.
- **Messy URLs**: `www.x.com`, `https://http://x.com/`, zero-width spaces before
  emails. `normUrl`/`normEmail` handle them.
- **Homepages link accounts that aren't theirs.** Wix templates link
  `instagram.com/wix`; pages link the organiser, the venue, a sponsor or a merch shop;
  expired domains serve spam ("Gathering" → a casino account). Site-builder handles
  are blocklisted, a profile counts only when exactly one is linked, and
  `accountFits()` keeps it only if its name visibly belongs to the festival (a
  distinctive word of the name, domain or email; or the name's initials or a name word
  next to a film word: `the_emff`, `chifilmfest`). The rest move to `site.rejected`.
  Every run re-vets stored layers under the current rules, with no refetch. Some real
  abbreviations are lost (`adlfilmfest` for Adelaide): dropped, not guessed.
- **Old Facebook URL forms**: `pg/<name>/about` is the page `<name>`; `pages/…`,
  `people/…`, `groups/…` and `p/…` keep their path; `profile.php?id=` keeps the id.
- **Borrowed values are re-normalised.** Festhome's sheet has corrupted handles
  (`instagram.com/noxfilfestival-viewer-location`) that must not spread.
- **Name matches are exact**: the normalised name (edition markers like `[EDICIÓN 2026]`,
  `10º`, `XVIII` dropped) plus the same country. A name one catalogue uses for two
  festivals never matches.

## Keywords (search demand panel)

`/fest-map/keypanel/` puts Google search volume for the services we sell next to the
map's festival counts, per market: **DCP creation**, **accessibility** (captions, audio
description, sign language), **copy & delivery software** (print traffic, DCP/KDM
delivery, screeners), **competitor & tool brands**, and a **proxy** for how many
filmmakers submit (platform names, submission terms). It's a go-to-market sizing tool,
unlisted (no link from the map,
`noindex`).

```
seeds.json (markets × keyword sets × discovery heads)
   → keywords.mjs: Keywordtool.io API, within budget and quota floor → keywords.json
   → + data*.json → public/fest-map/keypanel/data.json → the panel
```

```bash
npm run keywords -- --dry-run          # the queue and request count; no network
npm run keywords -- --build-only       # rebuild the panel data; no network
npm run keywords                       # due jobs (needs KEYWORDTOOL_API_KEY)
npm run keywords -- --only vol:br --budget 1
```

In Windows PowerShell, call `node ingest/keywords.mjs --dry-run` directly: PowerShell
drops the bare `--`, and npm then eats the flags (`--budget` becomes an npm config).

Runs daily in [`keywords.yml`](../.github/workflows/keywords.yml) (secret:
`KEYWORDTOOL_API_KEY`). `refresh-festmap.yml` and `deploy.yml` run `--build-only`, so
festival counts stay current at zero API cost. Research sessions through the
Keywordtool MCP follow [`keywords/RESEARCH.md`](keywords/RESEARCH.md).

**One volume job per market** carries every keyword in the market's languages plus the
language-neutral `any` lists (up to 1,000 per request). `metrics_language` is left out,
so volume counts every interface language. **Discovery jobs** are one suggestions call
per head and type, kept at volume ≥ 10; results not in the seeds become candidates in
the panel's Discovery tab.

Things that are easy to get wrong:

- **The quota is shared and rolling.** Starter is 50 requests in a rolling 24 hours,
  across the web app, API and MCP together. Every run reads `/v2/quota` first and spends
  `min(budget, remaining − floor)` (20 and 30 in `seeds.json`, leaving ~5 for MCP sessions
  and 25 for everything else). **An unreadable quota spends nothing** and exits 2.
- **Volume is a monthly average.** Asking again inside a month returns the same numbers.
  A job is due only when never run, older than `maxAgeDays` (28), or when `seeds.json`
  added keywords to it. Nothing due means no API call at all, not even the quota check.
- **Adding a keyword re-measures every market that includes it.** The whole market list
  is re-asked, so every number in a market shares one month. A new `en` or `any` keyword
  costs ~35 requests (~2 days of budget): **promote keywords in batches.**
- **Google groups close variants** and reports the group's numbers for each spelling.
  A keyword with the same volume, CPC and series as an earlier one in its set is marked
  `grouped` and counted once. Two unrelated low-volume keywords can collide; the error
  is small.
- **Every asked keyword gets an entry**, `null` when Google has no data. The API still
  returns a row for those, with `volume` and every month `null` (about a third of keywords
  in the first live run); they're stored as `null`, not counted as measured, and can't keep
  a job due forever. Results also match on the accent-folded form, in case the API
  echoes a keyword without its accents.
- **Broad and ambiguous keywords are flagged, not deleted.** `flagged` in `seeds.json`
  maps a keyword to the reason it's left out of totals; the panel still shows it. Found in
  the first run: "digital cinema package" (90K/mo worldwide: Google merges it with every
  meaning of "dcp"), general sign-language terms ("lengua de señas": 165K), "kdm
  management" (KDE's login manager). Flagging costs no requests.
- **Competitor and tool brands are their own set** (`brands`), so Eventive's viewer
  logins don't read as demand for delivery software.
- **Keywords are limited to 80 characters and 10 words**, lowercase, with most punctuation
  stripped (`cleanKeyword()`).
- **Google Ads doesn't serve every country.** Russia (`2643`) returns
  `Location '2643' is invalid` (error 14), so it has no market; its searches in Russian
  still count in Worldwide.
- **Festival counts** are unique by exact normalised name + country across the five
  catalogues (`matchKey`), so the real number is slightly lower where platforms spell a
  name differently. *Open now* is by deadline for every source, because Festhome's
  status text is frozen at scrape time.
- The API response fixtures (`fixtures/kw-cases.json`) are **synthetic**, from the
  documented shape plus the no-data row seen live. The collector doesn't keep raw
  responses; capture one to replace them if a parser ever needs changing.

To add a market: an entry in `markets` with the map's own country spelling, the Google
Ads location id (2000 + ISO 3166 numeric: Spain 724 → `2724`) and its keyword
languages. City locations (e.g. São Paulo) work the same way, with ids from Google Ads'
geotargets list, but the festival counts stay national.

### Before putting the map behind Cloudflare Access

- One Access application on `ingest.mov/fest-map*` covers the map, the panel, every
  `data*.json` and `POST /fest-map/refresh`. Everything fetches relative, same-origin.
- The map and panel fetch with `redirect: 'manual'`, so an expired session shows
  "reload to sign in" instead of a network error.
- **Check the sheet's Apps Script:** if it calls `/fest-map/refresh` on the Worker (not
  GitHub's dispatch API directly), it needs an Access service token or a bypass policy
  for that one path.
- CI deploys use the Cloudflare API token and aren't affected. The Keywordtool key is
  only a GitHub secret, never in the Worker or a page.

## Files

| File | Purpose |
|------|---------|
| `parse.mjs` | Pure CSV + row + API parsers (no I/O). |
| `ingest.mjs` | Fetch each source + geocode + write the `data*.json` files. |
| `geocache.json` | `Full Address → {lat,lon,prec}` cache. **Committed** so coords are reused; a normal run does zero geocoding. |
| `contacts-parse.mjs` | Pure contact parsers, normalisers and name matching (no I/O). |
| `contacts.mjs` | Fetch contacts for Shortfilmdepot / Festagent / Movibeta → `contacts.json`. |
| `contacts.json` | Contacts per festival id, with per-field provenance. **Committed**; merged by the ingest. |
| `keywords-parse.mjs` | Pure keyword-panel helpers: job queue, API response parsers, panel data (no I/O). |
| `keywords.mjs` | Keywordtool.io collector → `keywords.json`, then `public/fest-map/keypanel/data.json`. |
| `keywords/seeds.json` | Markets, keyword sets per language, discovery heads, collector budget. **Hand-edited.** |
| `keywords.json` | Search volume per job, one keyword per line, plus a run log. **Committed.** |
| `test.mjs` + `fixtures/` | Deterministic parser regression test against a committed sample (`npm run test:ingest`). |

## One-time setup

### 1. Make the sheet readable
In the sheet: **Share → General access → "Anyone with the link" → Viewer.**
That's all the ingest needs (it reads the public CSV export). The sheet's own
Apps Script keeps pulling from Festhome regardless.

### 2. Cloudflare API token (for CI deploys)
1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token → "Edit Cloudflare Workers"** template → create.
2. That token = `CLOUDFLARE_API_TOKEN`. Account ID = `9ebadf54c3839f299ce50b02d57a5489`.

### 3. GitHub repo secrets
`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | `9ebadf54c3839f299ce50b02d57a5489` |

(Optional) override the source via the `SHEET_ID` / `CSV_URL` env in the workflow.

Then **Actions → Refresh fest-map data → Run workflow** to test, or wait for the
weekly Monday 12:00 UTC run.

## Run locally

```bash
npm run ingest        # refresh all five sources -> public/fest-map/data*.json
npm run contacts      # (slow) contacts for sfd/fa/mb -> contacts.json + data*.json
npx wrangler deploy   # push live
npm run test:ingest   # deterministic parser regression test
```

## Notes
- **Past-event greying is decided on the map**, not here: a festival greys out once its **end** date passes (festivals running now stay active), judged against the map's live timezone (GMT-3 default, user-toggleable). The ingest only bakes data-integrity flags (`end before start`).
- Date strings handled: `DD Month YYYY`, `D Mon YYYY` (abbreviated), ISO, serials.
- Geocoding is OpenStreetMap **Nominatim** (1 req/s, cached). New festivals add a `geocache.json` entry committed on the next run.
- Source CSV defaults to the sheet's gviz export; override with `CSV_URL`.
- Change the schedule by editing the `cron` in the workflow.
