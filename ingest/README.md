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

The map carries three catalogues, each written to its own file and switched on or
off independently in the UI. **No source needs credentials.**

| Source | Key | Where the data comes from | Output |
|--------|-----|---------------------------|--------|
| Festhome | `festhome` | `Future Festivals` sheet tab (public CSV) | `data.json` |
| FilmFreeway | `ff` | `FilmFreeway` sheet tab + browser-scraped `filmfreeway-dates.json` | `data-ff.json` |
| Shortfilmdepot | `sfd` | the site's own public JSON API | `data-sfd.json` |

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
npm run ingest        # refresh all three sources -> public/fest-map/data*.json
npx wrangler deploy   # push live
npm run test:ingest   # deterministic parser regression test
```

## Notes
- **Past-event greying is decided on the map**, not here: a festival greys out once its **end** date passes (festivals running now stay active), judged against the map's live timezone (GMT-3 default, user-toggleable). The ingest only bakes data-integrity flags (`end before start`).
- Date strings handled: `DD Month YYYY`, `D Mon YYYY` (abbreviated), ISO, serials.
- Geocoding is OpenStreetMap **Nominatim** (1 req/s, cached). New festivals add a `geocache.json` entry committed on the next run.
- Source CSV defaults to the sheet's gviz export; override with `CSV_URL`.
- Change the schedule by editing the `cron` in the workflow.
