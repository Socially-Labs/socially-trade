-- Disposable read model. Accounting observations remain the source of truth.
CREATE TABLE captain_discovery_metrics (
  captain_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  range text NOT NULL CHECK (range IN ('7D','30D','90D','ALL')),
  source_revision bigint NOT NULL,
  aum_usdc numeric,
  net_pnl_usdc numeric,
  net_return_percent numeric,
  crew_members integer NOT NULL CHECK (crew_members >= 0),
  active_vaults integer NOT NULL,
  total_vaults integer NOT NULL,
  portfolio jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (captain_id,range)
);
CREATE INDEX captain_discovery_refresh ON captain_discovery_metrics(range,computed_at);
CREATE INDEX captain_discovery_return ON captain_discovery_metrics(range,net_return_percent DESC NULLS LAST,captain_id);
COMMENT ON TABLE captain_discovery_metrics IS 'Worker-maintained public performance projection; backfilled automatically from recorded NAV. Never used for trading or settlement.';
