-- Onchain custody is deliberately isolated from funds/paper_cash and the paper worker.
CREATE TABLE live_vaults (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  wallet text NOT NULL,
  fund_address text NOT NULL UNIQUE,
  fund_number numeric(20,0) NOT NULL,
  share_mint text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
  description text NOT NULL CHECK (length(description)<=1000),
  seed_usdc_raw numeric(20,0) NOT NULL CHECK (seed_usdc_raw>=100000000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_vaults_owner_idx ON live_vaults(user_id,created_at DESC,id DESC);
CREATE TABLE live_vault_transactions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  client_request_id uuid NOT NULL,
  request_hash text NOT NULL,
  vault_id uuid NOT NULL REFERENCES live_vaults(id),
  kind text NOT NULL CHECK (kind IN ('CREATE','EXIT')),
  input_asset text NOT NULL CHECK (input_asset IN ('SOL','USDC','SHARES')),
  input_raw numeric(20,0) NOT NULL CHECK (input_raw>0),
  status text NOT NULL CHECK (status IN ('PREPARED','SUBMITTED','CONFIRMED','FAILED','EXPIRED')),
  unsigned_transaction text NOT NULL,
  signed_transaction text,
  signature text UNIQUE,
  last_valid_block_height bigint NOT NULL,
  fees jsonb NOT NULL,
  failure text,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,client_request_id)
);
CREATE INDEX live_vault_transactions_pending_idx ON live_vault_transactions(next_check_at) WHERE status IN ('PREPARED','SUBMITTED');
CREATE UNIQUE INDEX live_vault_transactions_exit_idx ON live_vault_transactions(vault_id) WHERE kind='EXIT' AND status IN ('PREPARED','SUBMITTED');
