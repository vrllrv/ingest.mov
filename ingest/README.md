# fest-map data ingest

Pulls the **"Future Festivals"** Google Sheet tab (public, CSV) → parses dates →
geocodes addresses → writes [`../public/fest-map/data.json`](../public/fest-map/data.json),
which the map fetches at runtime. Runs daily via
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

## Files

| File | Purpose |
|------|---------|
| `parse.mjs` | Pure CSV + row + API parsers (no I/O). |
| `ingest.mjs` | Fetch each source + geocode + write the `data*.json` files. |
| `geocache.json` | `Full Address → {lat,lon,prec}` cache. **Committed** so coords are reused; a normal run does zero geocoding. |
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
daily 06:00 UTC run.

## Run locally

```bash
npm run ingest        # refresh all five sources -> public/fest-map/data*.json
npx wrangler deploy   # push live
npm run test:ingest   # deterministic parser regression test
```

## Notes
- **Past-event greying is decided on the map**, not here: a festival greys out once its **end** date passes (festivals running now stay active), judged against the map's live timezone (GMT-3 default, user-toggleable). The ingest only bakes data-integrity flags (`end before start`).
- Date strings handled: `DD Month YYYY`, `D Mon YYYY` (abbreviated), ISO, serials.
- Geocoding is OpenStreetMap **Nominatim** (1 req/s, cached). New festivals add a `geocache.json` entry committed on the next run.
- Source CSV defaults to the sheet's gviz export; override with `CSV_URL`.
- Change the schedule by editing the `cron` in the workflow.
