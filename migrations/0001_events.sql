-- DCP paid-search test (ingest/keywords/VALIDATION.md): one row per order click
-- or quote request from /dcp/. Paid orders live in Stripe and join on
-- client_reference_id = events.id. Attribution comes from the Google Ads final
-- URL suffix (ValueTrack), copied by the page; country from request.cf.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('order_click', 'quote')),
  tier TEXT,
  country TEXT,
  gclid TEXT,
  source TEXT,
  campaign TEXT,
  adgroup TEXT,
  term TEXT,
  matchtype TEXT,
  email TEXT,
  film TEXT,
  runtime_min INTEGER,
  source_format TEXT,
  deadline TEXT,
  festival TEXT,
  message TEXT
);

CREATE INDEX events_at ON events (at);
