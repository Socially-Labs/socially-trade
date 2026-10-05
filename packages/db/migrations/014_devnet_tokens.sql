-- Devnet token layer: only money in and out touches Solana devnet.
-- Trades, P&L, fees and captains stay in the paper ledger.

CREATE TABLE user_wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  address text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Transfers that the backend signs and sends. The intent row exists before the send.
-- A new signature replaces the old one only after the old one can no longer land.
CREATE TABLE token_payouts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('SIGNUP_GRANT', 'WITHDRAWAL')),
  user_id uuid NOT NULL REFERENCES users(id),
  wallet text NOT NULL,
  amount_raw bigint NOT NULL CHECK (amount_raw > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED')),
  signature text UNIQUE,
  wire_transaction text,
  last_valid_block_height bigint,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  event_id uuid REFERENCES fund_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_signup_grant_per_user ON token_payouts(user_id) WHERE kind = 'SIGNUP_GRANT';
CREATE INDEX token_payouts_pending_idx ON token_payouts(user_id) WHERE status = 'PENDING';

-- Transfers that a user signs and the client submits. A claim is per (signature, user),
-- so a stranger who posts a signature first cannot block its owner.
-- One signature can credit the paper ledger only once.
CREATE TABLE token_deposits (
  id uuid PRIMARY KEY,
  signature text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  amount_raw bigint NOT NULL CHECK (amount_raw > 0),
  fund_id uuid REFERENCES funds(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  failure text,
  event_id uuid REFERENCES fund_events(id),
  join_event_id uuid,
  join_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signature, user_id)
);

CREATE UNIQUE INDEX one_credit_per_signature ON token_deposits(signature) WHERE status = 'CONFIRMED';
