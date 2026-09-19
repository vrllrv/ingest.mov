-- Landing-page views of /dcp/, counted by the page itself (POST /dcp/v), for the
-- navigator's funnel. Cloudflare Web Analytics keeps about 1 page load in 10, which
-- at 60-150 ad clicks a month leaves mostly noise. Same attribution as events, minus
-- the click ID: a view doesn't need to join anything.
CREATE TABLE views (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  country TEXT,
  source TEXT,
  campaign TEXT,
  adgroup TEXT,
  term TEXT,
  matchtype TEXT
);

CREATE INDEX views_at ON views (at);
