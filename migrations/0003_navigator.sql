-- MVP navigator (/admin), phase 1.
-- settings: launch_date (YYYY-MM-DD), price (the short-film price P), margin (%),
-- so the gates can be evaluated as P x m.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  at TEXT NOT NULL
);

-- Google Ads totals entered by hand, one row per day (or per week, dated on its
-- last day). The Ads API needs developer-token approval; not worth it at this volume.
CREATE TABLE ad_spend (
  day TEXT PRIMARY KEY,
  spend REAL NOT NULL,
  clicks INTEGER,
  impressions INTEGER,
  note TEXT,
  at TEXT NOT NULL
);
