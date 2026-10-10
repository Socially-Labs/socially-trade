-- Additive registry, policy evidence, durable demand and isolated chart storage.
ALTER TABLE instruments ADD COLUMN registration_source text NOT NULL DEFAULT 'LEGACY';
ALTER TABLE instruments ADD COLUMN registered_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE instruments ADD COLUMN eligibility text NOT NULL DEFAULT 'ELIGIBLE' CHECK(eligibility IN ('ELIGIBLE','SELL_ONLY','DISABLED'));
ALTER TABLE instruments ADD COLUMN eligibility_reason text;
ALTER TABLE fund_policy_versions ADD COLUMN universe_mode text NOT NULL DEFAULT 'LEGACY_ALLOWLIST' CHECK(universe_mode IN ('LEGACY_ALLOWLIST','DYNAMIC_SPOT'));
ALTER TABLE orders ADD COLUMN policy_version integer;
ALTER TABLE orders ADD CONSTRAINT orders_policy_version_fk FOREIGN KEY(fund_id,policy_version) REFERENCES fund_policy_versions(fund_id,version);
CREATE TABLE market_tracking_state (
 instrument_id text PRIMARY KEY REFERENCES instruments(id), priority integer NOT NULL DEFAULT 2,
 next_due_at timestamptz NOT NULL DEFAULT now(), last_success_at timestamptz,
 failure_count integer NOT NULL DEFAULT 0, backoff_until timestamptz
);
CREATE INDEX market_tracking_due_idx ON market_tracking_state(next_due_at);
CREATE INDEX positions_demand_idx ON positions(instrument_id,fund_id) WHERE quantity>0;
CREATE INDEX orders_demand_idx ON orders(instrument_id,fund_id) WHERE status='PENDING';
CREATE TABLE market_chart_candles (
 instrument_id text NOT NULL REFERENCES instruments(id), source text NOT NULL, series_id text NOT NULL,
 denomination text NOT NULL CHECK(denomination='USD'), resolution_seconds integer NOT NULL CHECK(resolution_seconds>0),
 bucket_at timestamptz NOT NULL, open numeric(38,18) NOT NULL CHECK(open>0), high numeric(38,18) NOT NULL CHECK(high>0),
 low numeric(38,18) NOT NULL CHECK(low>0), close numeric(38,18) NOT NULL CHECK(close>0), volume numeric(38,18) CHECK(volume>=0),
 sample_count integer, final boolean NOT NULL, retrieved_at timestamptz NOT NULL DEFAULT now(), revised_at timestamptz NOT NULL DEFAULT now(),
 CHECK(high>=greatest(open,close,low) AND low<=least(open,close,high)),
 PRIMARY KEY(instrument_id,source,series_id,resolution_seconds,bucket_at)
);
CREATE TABLE market_history_jobs (
 work_key text PRIMARY KEY, instrument_id text NOT NULL REFERENCES instruments(id), source text NOT NULL,
 resolution_seconds integer NOT NULL, from_at timestamptz NOT NULL, to_at timestamptz NOT NULL CHECK(to_at>from_at),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','COMPLETE','UNAVAILABLE')),
 attempts integer NOT NULL DEFAULT 0, next_run_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 last_error text, covered_from timestamptz, covered_to timestamptz
);
CREATE INDEX market_history_jobs_due_idx ON market_history_jobs(next_run_at) WHERE status IN ('PENDING','RUNNING');
