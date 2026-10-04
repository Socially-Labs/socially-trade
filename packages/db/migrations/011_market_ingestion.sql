CREATE TABLE market_feed_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  sequence bigint NOT NULL DEFAULT 0
);
INSERT INTO market_feed_state(singleton) VALUES(true);
ALTER TABLE price_observations ADD COLUMN source_block_id bigint;
ALTER TABLE price_observations ADD COLUMN price_usd numeric(38,18);
ALTER TABLE price_observations ADD COLUMN quote_usd numeric(38,18);

CREATE TABLE market_events (
  sequence bigint PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  instrument_id text NOT NULL REFERENCES instruments(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX market_events_pending ON market_events(sequence) WHERE delivered_at IS NULL;
CREATE TABLE market_latest (
  instrument_id text PRIMARY KEY REFERENCES instruments(id),
  sequence bigint NOT NULL REFERENCES market_events(sequence),
  payload jsonb NOT NULL
);

ALTER TABLE price_observations ADD COLUMN quote_source_block_id bigint;
ALTER TABLE price_observations ADD COLUMN quote_source_at timestamptz;
