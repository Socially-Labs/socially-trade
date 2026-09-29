CREATE TABLE users (
  id uuid PRIMARY KEY,
  auth_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  paper_cash numeric(38, 18) NOT NULL DEFAULT 0 CHECK (paper_cash >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE captain_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  handle text NOT NULL UNIQUE,
  bio text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instruments (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  mint_address text,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE funds (
  id uuid PRIMARY KEY,
  captain_id uuid NOT NULL REFERENCES captain_profiles(user_id),
  mode text NOT NULL DEFAULT 'PAPER' CHECK (mode = 'PAPER'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'COMPLETED')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  cash_usdc numeric(38, 18) NOT NULL DEFAULT 0 CHECK (cash_usdc >= 0),
  total_shares numeric(38, 18) NOT NULL DEFAULT 0 CHECK (total_shares >= 0),
  high_water_mark numeric(38, 18) NOT NULL DEFAULT 1 CHECK (high_water_mark > 0),
  peak_share_price numeric(38, 18) NOT NULL DEFAULT 1 CHECK (peak_share_price > 0),
  event_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_active_fund_per_captain ON funds(captain_id)
  WHERE status IN ('ACTIVE', 'FROZEN');

CREATE TABLE fund_policy_versions (
  fund_id uuid NOT NULL REFERENCES funds(id),
  version integer NOT NULL CHECK (version > 0),
  max_order_bps integer NOT NULL CHECK (max_order_bps BETWEEN 1 AND 10000),
  max_position_bps integer NOT NULL CHECK (max_position_bps BETWEEN 1 AND 10000),
  drawdown_breaker_bps integer NOT NULL CHECK (drawdown_breaker_bps BETWEEN 1 AND 10000),
  allowed_instruments text[] NOT NULL,
  effective_at timestamptz NOT NULL,
  PRIMARY KEY (fund_id, version)
);

CREATE TABLE trials (
  fund_id uuid PRIMARY KEY REFERENCES funds(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  seed_usdc numeric(38, 18) NOT NULL CHECK (seed_usdc > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED'))
);

CREATE TABLE fund_shares (
  fund_id uuid NOT NULL REFERENCES funds(id),
  user_id uuid NOT NULL REFERENCES users(id),
  shares numeric(38, 18) NOT NULL DEFAULT 0 CHECK (shares >= 0),
  PRIMARY KEY (fund_id, user_id)
);

CREATE TABLE positions (
  fund_id uuid NOT NULL REFERENCES funds(id),
  instrument_id text NOT NULL REFERENCES instruments(id),
  quantity numeric(38, 18) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  cost_basis_usdc numeric(38, 18) NOT NULL DEFAULT 0 CHECK (cost_basis_usdc >= 0),
  PRIMARY KEY (fund_id, instrument_id)
);

CREATE TABLE fund_events (
  id uuid PRIMARY KEY,
  fund_id uuid REFERENCES funds(id),
  sequence bigint,
  type text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fund_id, sequence)
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('USER', 'FUND', 'MARKET', 'ISSUANCE', 'PROTOCOL')),
  owner_id text NOT NULL,
  asset_id text NOT NULL,
  UNIQUE (owner_type, owner_id, asset_id)
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES fund_events(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  amount numeric(38, 18) NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_event_idx ON ledger_entries(event_id);

CREATE TABLE price_observations (
  id uuid PRIMARY KEY,
  instrument_id text NOT NULL REFERENCES instruments(id),
  source text NOT NULL,
  source_ref text,
  price_usdc numeric(38, 18) NOT NULL CHECK (price_usdc > 0),
  liquidity_usdc numeric(38, 18) CHECK (liquidity_usdc > 0),
  source_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX price_observations_latest_idx ON price_observations(instrument_id, source_at DESC);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  fund_id uuid NOT NULL REFERENCES funds(id),
  captain_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  instrument_id text NOT NULL REFERENCES instruments(id),
  notional_usdc numeric(38, 18) NOT NULL CHECK (notional_usdc > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED')),
  reject_reason text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (captain_id, idempotency_key)
);

CREATE INDEX orders_pending_idx ON orders(submitted_at) WHERE status = 'PENDING';

CREATE TABLE fills (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  observation_id uuid NOT NULL REFERENCES price_observations(id),
  quantity numeric(38, 18) NOT NULL CHECK (quantity > 0),
  market_price_usdc numeric(38, 18) NOT NULL CHECK (market_price_usdc > 0),
  fill_price_usdc numeric(38, 18) NOT NULL CHECK (fill_price_usdc > 0),
  fee_usdc numeric(38, 18) NOT NULL CHECK (fee_usdc >= 0),
  model_version integer NOT NULL,
  filled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nav_snapshots (
  id uuid PRIMARY KEY,
  fund_id uuid NOT NULL REFERENCES funds(id),
  nav_usdc numeric(38, 18),
  share_price_usdc numeric(38, 18),
  status text NOT NULL CHECK (status IN ('CURRENT', 'UNAVAILABLE')),
  priced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nav_snapshots_latest_idx ON nav_snapshots(fund_id, created_at DESC);

CREATE TABLE fee_assessments (
  id uuid PRIMARY KEY,
  fund_id uuid NOT NULL REFERENCES funds(id),
  fee_day date NOT NULL,
  fee_usdc numeric(38, 18) NOT NULL CHECK (fee_usdc >= 0),
  shares_minted numeric(38, 18) NOT NULL CHECK (shares_minted >= 0),
  event_id uuid NOT NULL REFERENCES fund_events(id),
  UNIQUE (fund_id, fee_day)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  fund_id uuid NOT NULL REFERENCES funds(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  linked_order_id uuid REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  fund_event_id uuid NOT NULL REFERENCES fund_events(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
