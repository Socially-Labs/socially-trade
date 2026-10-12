-- A user-local cursor is assigned under a row lock held until commit. Global
-- identity IDs can commit out of order and are unsuitable for incremental replay.
ALTER TABLE notifications ALTER COLUMN fund_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN stream_sequence bigint;
WITH ordered AS (
 SELECT id,row_number() OVER (PARTITION BY user_id ORDER BY id) AS seq FROM notifications
) UPDATE notifications n SET stream_sequence=o.seq FROM ordered o WHERE o.id=n.id;
CREATE TABLE notification_stream_state (
 user_id uuid PRIMARY KEY REFERENCES users(id), sequence bigint NOT NULL DEFAULT 0
);
INSERT INTO notification_stream_state SELECT user_id,max(stream_sequence) FROM notifications GROUP BY user_id;
CREATE FUNCTION assign_notification_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO notification_stream_state(user_id,sequence) VALUES(NEW.user_id,1)
 ON CONFLICT(user_id) DO UPDATE SET sequence=notification_stream_state.sequence+1
 RETURNING sequence INTO NEW.stream_sequence;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_sequence BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION assign_notification_sequence();
ALTER TABLE notifications ALTER COLUMN stream_sequence SET NOT NULL;
CREATE UNIQUE INDEX notifications_user_sequence ON notifications(user_id,stream_sequence);
CREATE FUNCTION notify_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('account_notifications',NEW.user_id::text);
 RETURN NEW;
END $$;
CREATE TRIGGER notification_committed AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notify_notification_delivery();

CREATE TABLE notification_devices (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 token text NOT NULL UNIQUE, platform text NOT NULL CHECK(platform IN ('android','ios')),
 updated_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX notification_devices_active ON notification_devices(user_id) WHERE revoked_at IS NULL;
CREATE TABLE notification_push_deliveries (
 notification_id bigint NOT NULL REFERENCES notifications(id), device_id uuid NOT NULL REFERENCES notification_devices(id),
 -- Snapshot the target. Reassignment/logout must never deliver an old account's alert.
 user_id uuid NOT NULL REFERENCES users(id), token text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ticket_id text, receipt_due_at timestamptz, delivered_at timestamptz, failed_at timestamptz,
 last_error text, PRIMARY KEY(notification_id,device_id)
);
CREATE INDEX notification_push_pending ON notification_push_deliveries(next_attempt_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE FUNCTION queue_notification_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO notification_push_deliveries(notification_id,device_id,user_id,token)
 SELECT NEW.id,d.id,NEW.user_id,d.token FROM notification_devices d
 WHERE d.user_id=NEW.user_id AND d.revoked_at IS NULL AND d.updated_at>now()-interval '30 days';
 RETURN NEW;
END $$;
CREATE TRIGGER notification_push AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION queue_notification_push();

-- Only finalized chain receipts enter this ledger. This never credits paper cash.
CREATE TABLE wallet_notification_watches (
 user_id uuid PRIMARY KEY REFERENCES users(id), address text NOT NULL UNIQUE,
 network text NOT NULL CHECK(network='devnet'), last_signature text,
 initialized boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallet_notification_receipts (
 network text NOT NULL, signature text NOT NULL, transfer_index text NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id), token text NOT NULL CHECK(token IN ('SOL','USDC')),
 amount_atomic numeric(40,0) NOT NULL CHECK(amount_atomic>0), decimals integer NOT NULL,
 slot bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(network,signature,transfer_index,user_id)
);
-- SPL transfers reference the recipient's token account, often without the
-- wallet owner in the transaction keys. Each watched address needs its own cursor.
CREATE TABLE wallet_notification_addresses (
 user_id uuid NOT NULL REFERENCES wallet_notification_watches(user_id) ON DELETE CASCADE,
 address text NOT NULL, last_signature text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,address)
);
CREATE INDEX wallet_notification_scan_due ON wallet_notification_addresses(updated_at);
