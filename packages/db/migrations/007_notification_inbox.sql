CREATE UNIQUE INDEX outbox_one_record_per_event ON outbox_events(fund_event_id);

CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_event_id uuid NOT NULL REFERENCES outbox_events(id),
  user_id uuid NOT NULL REFERENCES users(id),
  fund_id uuid NOT NULL REFERENCES funds(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (outbox_event_id, user_id)
);

CREATE INDEX notifications_user_cursor_idx ON notifications(user_id, id);
