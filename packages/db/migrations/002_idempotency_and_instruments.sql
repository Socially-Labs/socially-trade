CREATE TABLE api_idempotency (
  user_id uuid NOT NULL REFERENCES users(id),
  key text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  status_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

INSERT INTO instruments (id, symbol, decimals, active)
VALUES ('SOL', 'SOL', 9, true)
ON CONFLICT (id) DO NOTHING;
