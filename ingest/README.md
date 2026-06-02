# fest-map data ingest

Pulls the **private** "Future Festivals" Google Sheet → parses dates → geocodes
addresses → writes [`../public/fest-map/data.json`](../public/fest-map/data.json),
which the map fetches at runtime. Runs daily via
[`.github/workflows/refresh-festmap.yml`](../.github/workflows/refresh-festmap.yml).

```
Festhome → (your private sheet, auto-pull) → ingest.mjs
   → parse "Future Festivals" tab → geocode (cached) → data.json → wrangler deploy
```

Only the **`Future Festivals`** tab is read. `Sheet1` (raw/past festivals) is ignored.

## Files

| File | Purpose |
|------|---------|
| `parse.mjs` | Pure sheet-row → record parser (no I/O). |
| `ingest.mjs` | Sheets API fetch + geocode + write `data.json`. |
| `geocache.json` | `Full Address → {lat,lon,prec}` cache. **Committed** so coords are reused; a normal run does zero geocoding. |
| `test-parse.mjs` | Validates `parse.mjs` against the known-good `data.json`. |

## One-time setup

### 1. Google service account (keeps the sheet private)
1. <https://console.cloud.google.com/> → create/select a project.
2. **APIs & Services → Library → Google Sheets API → Enable.**
3. **APIs & Services → Credentials → Create credentials → Service account.** Name it e.g. `festmap-ingest`. No roles needed.
4. Open the service account → **Keys → Add key → Create new key → JSON.** A `.json` file downloads — this is `GOOGLE_SERVICE_ACCOUNT_KEY`.
5. Copy the service account email (`festmap-ingest@PROJECT.iam.gserviceaccount.com`).

### 2. Share + privatise the sheet
1. In the sheet: **Share** → add the service-account email as **Viewer**.
2. Remove "Anyone with the link" → the sheet is now **private**; the ingest still reads it via the service account, and its Festhome auto-pull keeps working.

### 3. Cloudflare API token (for CI deploys)
1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token → "Edit Cloudflare Workers"** template → create.
2. That token = `CLOUDFLARE_API_TOKEN`. Account ID = `9ebadf54c3839f299ce50b02d57a5489`.

### 4. GitHub repo secrets
`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|--------|-------|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | full contents of the service-account `.json` |
| `CLOUDFLARE_API_TOKEN` | the token from step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | `9ebadf54c3839f299ce50b02d57a5489` |
| `SHEET_ID` | `1Ie60CKn3zlt5MFB43nt5GM6h6gbAO-p1wDvaTmB27xk` (optional; defaults in code) |

Then **Actions → Refresh fest-map data → Run workflow** to test, or wait for the daily 06:00 UTC run.

## Run locally

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
npm run ingest        # regenerates public/fest-map/data.json
npx wrangler deploy   # push live
```

`npm run test:ingest` re-runs the parser validation (needs the fixture at
`/tmp/ff_values.json`; regenerate from the sheet export if absent).

## Notes
- "Today" for the past-event flag uses **GMT-3** (`TZ_OFFSET`, override via env).
- Geocoding is OpenStreetMap **Nominatim** (1 req/s, cached). New festivals add a `geocache.json` entry committed on the next run.
- Change the schedule by editing the `cron` in the workflow.
