-- One receipt across both linked-wallet claims and external-wallet QR payments.
CREATE TABLE token_deposit_receipts (
  signature text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO token_deposit_receipts(signature, user_id)
SELECT signature, user_id FROM token_deposits WHERE status = 'CONFIRMED';

CREATE TABLE qr_deposits (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  reference text NOT NULL UNIQUE,
  mint text NOT NULL,
  recipient text NOT NULL,
  treasury_ata text NOT NULL,
  amount_raw bigint NOT NULL CHECK (amount_raw >= 1000000 AND amount_raw <= 1000000000000),
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'CONFIRMING', 'CONFIRMED', 'EXPIRED')),
  credited_raw numeric(30,0) NOT NULL DEFAULT 0,
  signature text,
  last_error text,
  scan_until text,
  scan_before text,
  scan_head text,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qr_deposits_user_idx ON qr_deposits(user_id, created_at DESC, id DESC);
CREATE INDEX qr_deposits_scan_idx ON qr_deposits(next_scan_at);

CREATE TABLE qr_deposit_attempts (
  deposit_id uuid NOT NULL REFERENCES qr_deposits(id),
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REJECTED', 'CREDITED')),
  failure text,
  event_id uuid REFERENCES fund_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT 'epoch',
  PRIMARY KEY (deposit_id, signature)
);
