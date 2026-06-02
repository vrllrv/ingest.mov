# fest-map data ingest

Pulls the **"Future Festivals"** Google Sheet tab (public, CSV) → parses dates →
geocodes addresses → writes [`../public/fest-map/data.json`](../public/fest-map/data.json),
which the map fetches at runtime. Runs daily via
[`.github/workflows/refresh-festmap.yml`](../.github/workflows/refresh-festmap.yml).

```
Festhome → (sheet's Apps Script auto-pull) → Future Festivals tab
   → ingest.mjs: parse + geocode (cached) → data.json → wrangler deploy
```

Only the **`Future Festivals`** tab is read. `Sheet1` (raw/past festivals) is ignored.
No Google credentials are used — the sheet holds only public Festhome data and is
read via its public CSV export.

## Files

| File | Purpose |
|------|---------|
| `parse.mjs` | Pure CSV + row parser (no I/O). |
| `ingest.mjs` | Fetch public CSV + geocode + write `data.json`. |
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
npm run ingest        # fetch public CSV -> regenerate public/fest-map/data.json
npx wrangler deploy   # push live
npm run test:ingest   # deterministic parser regression test
```

## Notes
- "Today" for the past-event flag uses **GMT-3** (`TZ_OFFSET`, override via env).
- Date strings handled: `DD Month YYYY`, `D Mon YYYY` (abbreviated), ISO, serials.
- Geocoding is OpenStreetMap **Nominatim** (1 req/s, cached). New festivals add a `geocache.json` entry committed on the next run.
- Source CSV defaults to the sheet's gviz export; override with `CSV_URL`.
- Change the schedule by editing the `cron` in the workflow.
