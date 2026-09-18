-- Paid orders, written by the Stripe webhook (POST /stripe/webhook).
-- `ref` is the Checkout Session's client_reference_id, which /go/order set to the
-- events.id of the click, so an order joins back to the ad keyword that produced it.
-- The session id is the primary key, so a redelivered event can't double-count.
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  event_id TEXT,
  ref TEXT,
  amount_total INTEGER,
  currency TEXT,
  email TEXT,
  name TEXT,
  film TEXT,
  master_link TEXT,
  custom_fields TEXT,
  payment_status TEXT,
  livemode INTEGER
);

CREATE INDEX orders_ref ON orders (ref);
