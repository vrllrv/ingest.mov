# FilmFreeway date scraper

FilmFreeway's festival **directory listing** (the `FilmFreeway` sheet tab) has no
dates — submission deadlines and event dates live only on each festival's
**detail page**, which is behind a Cloudflare JS challenge (server scraping = 403).

`filmfreeway-scraper.user.js` sidesteps that by running in **your own browser**,
where Cloudflare is already satisfied. It crawls detail pages same-origin,
throttled and resumable, and exports `filmfreeway-dates.json` for the ingest.

## Install
1. Install the **Tampermonkey** extension.
2. Tampermonkey → Create a new script → paste `filmfreeway-scraper.user.js` → save.
3. Open https://filmfreeway.com/festivals — a panel appears bottom-right.

## First run (finalize the parser)
1. Open one festival page, e.g. `https://filmfreeway.com/RavenheartInternationalFilmFestival`.
2. Click **"Scrape THIS page (diagnostic)"** and send the JSON output back so the
   `extractDates()` function can be finalized to the real DOM.

## Backfill
1. Paste `ff-slugs.json` into the panel, press **Start** (Open festivals are
   worth doing first). ~18s/page; stop/resume anytime.
2. **Export** → drop `filmfreeway-dates.json` in the repo; ingest merges it into
   `data-ff.json`, keyed by `ff:<slug>`.

## Weekly
Re-run only the diff (new slugs + Open + near-deadline). Fast after the backfill.
