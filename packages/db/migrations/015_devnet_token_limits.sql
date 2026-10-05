-- Devnet token layer limits: treasury-paid token account creations and per-user rates.

-- How many times the treasury paid the rent for this user's token account. The API caps it.
ALTER TABLE user_wallets ADD COLUMN ata_creations integer NOT NULL DEFAULT 0 CHECK (ata_creations >= 0);

-- One row per deposit prepare in the last hour, for the per-user rate limit.
CREATE TABLE deposit_prepares (
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deposit_prepares_user_idx ON deposit_prepares(user_id, created_at);

-- A short claim on the right to sign the next payout transaction. It is held with no
-- transaction open, while the API reads the chain and signs, so parallel callers sign once.
ALTER TABLE token_payouts ADD COLUMN signing_until timestamptz;

CREATE INDEX token_payouts_withdrawal_rate_idx ON token_payouts(user_id, created_at) WHERE kind = 'WITHDRAWAL';
