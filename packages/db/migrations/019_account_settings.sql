ALTER TABLE users
  ADD COLUMN hide_balances boolean NOT NULL DEFAULT false,
  ADD COLUMN avatar_kind text NOT NULL DEFAULT 'captain' CHECK (avatar_kind IN ('captain', 'initials'));

CREATE TABLE support_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  message text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 2000),
  app_version text NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 40),
  platform text NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_requests_user_created ON support_requests(user_id, created_at DESC);
