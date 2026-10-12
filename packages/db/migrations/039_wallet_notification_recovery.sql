-- Persist backfill progress separately from the fully scanned high-water mark.
-- Large outages must make bounded progress instead of repeatedly failing a cap.
ALTER TABLE wallet_notification_addresses ADD COLUMN backfill_before text;
ALTER TABLE wallet_notification_addresses ADD COLUMN head_signature text;
