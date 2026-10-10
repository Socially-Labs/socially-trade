-- Additive discovery storage only; no financial columns or policies change.
CREATE TABLE market_discovery_feeds (
  cache_key text PRIMARY KEY,
  snapshot_id uuid NOT NULL,
  fetched_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'array' AND jsonb_array_length(payload) <= 100)
);
CREATE INDEX market_discovery_feeds_fetched_at_idx ON market_discovery_feeds(fetched_at);
CREATE TABLE market_return_rollups (
  instrument_id text NOT NULL REFERENCES instruments(id),
  interval text NOT NULL CHECK (interval IN ('7d','30d')),
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (instrument_id, interval)
);

-- Older normalization treated absent audit.isSus as false. Preserve true flags,
-- but restore unknowns until a schema-v2 provider refresh supplies explicit values.
UPDATE market_token_metadata SET payload = payload || jsonb_build_object(
  'schemaVersion', 1, 'suspicious', CASE WHEN payload->'suspicious'='true'::jsonb THEN true ELSE NULL END)
WHERE NOT payload ? 'schemaVersion';
