-- Real devnet wallet swaps. These tables never participate in the paper ledger.
CREATE TABLE wallet_swap_quotes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  wallet text NOT NULL,
  quote jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_swap_quotes_rate_idx ON wallet_swap_quotes(user_id, created_at);
CREATE TABLE wallet_swaps (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  client_request_id uuid NOT NULL,
  quote_id uuid NOT NULL UNIQUE REFERENCES wallet_swap_quotes(id),
  wallet text NOT NULL,
  cluster text NOT NULL CHECK (cluster = 'devnet'),
  quote jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PREPARED','SUBMITTED','CONFIRMED','FAILED','EXPIRED')),
  unsigned_transaction text NOT NULL,
  signed_transaction text,
  signature text UNIQUE,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  fees jsonb NOT NULL,
  filled_output_raw numeric(20,0),
  actual_network_fee_lamports bigint,
  failure text,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,client_request_id),
  CHECK ((signature IS NULL) = (signed_transaction IS NULL))
);
CREATE INDEX wallet_swaps_history_idx ON wallet_swaps(user_id,created_at DESC,id DESC);
CREATE INDEX wallet_swaps_pending_idx ON wallet_swaps(next_check_at) WHERE status IN ('PREPARED','SUBMITTED');
-- Count reservations as well as successful requests, including upstream failures.
CREATE TABLE wallet_swap_requests (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('quote','prepare','submit','read')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_swap_requests_rate_idx ON wallet_swap_requests(user_id,kind,created_at);
