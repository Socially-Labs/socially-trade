-- Two bounded read models per round. Updating a mark and its chart buckets is atomic.
CREATE TABLE vault_performance_rollups (
 fund_id uuid NOT NULL REFERENCES vault_rounds(fund_id), interval_seconds integer NOT NULL CHECK(interval_seconds IN (3600,86400)),
 bucket_at timestamptz NOT NULL, priced_at timestamptz NOT NULL, source_created_at timestamptz NOT NULL,
 event_sequence bigint NOT NULL, nav_usdc numeric NOT NULL CHECK(nav_usdc>=0), share_price_usdc numeric NOT NULL CHECK(share_price_usdc>=0),
 PRIMARY KEY(fund_id,interval_seconds,bucket_at)
);
CREATE FUNCTION record_vault_performance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seconds integer;
BEGIN
 IF NEW.status<>'CURRENT' OR NEW.priced_at IS NULL OR NEW.nav_usdc IS NULL OR NEW.share_price_usdc IS NULL
  OR NEW.priced_at>clock_timestamp()+interval '5 seconds'
  OR NOT EXISTS(SELECT 1 FROM vault_rounds WHERE fund_id=NEW.fund_id) THEN RETURN NEW; END IF;
 FOREACH seconds IN ARRAY ARRAY[3600,86400] LOOP
  INSERT INTO vault_performance_rollups(fund_id,interval_seconds,bucket_at,priced_at,source_created_at,event_sequence,nav_usdc,share_price_usdc)
  VALUES(NEW.fund_id,seconds,to_timestamp(floor(extract(epoch FROM NEW.priced_at)/seconds)*seconds),NEW.priced_at,NEW.created_at,COALESCE(NEW.event_sequence,0),NEW.nav_usdc,NEW.share_price_usdc)
  ON CONFLICT(fund_id,interval_seconds,bucket_at) DO UPDATE SET priced_at=EXCLUDED.priced_at,source_created_at=EXCLUDED.source_created_at,
   event_sequence=EXCLUDED.event_sequence,nav_usdc=EXCLUDED.nav_usdc,share_price_usdc=EXCLUDED.share_price_usdc
  WHERE (EXCLUDED.event_sequence,EXCLUDED.source_created_at) >= (vault_performance_rollups.event_sequence,vault_performance_rollups.source_created_at);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER vault_performance_snapshot AFTER INSERT ON nav_snapshots FOR EACH ROW EXECUTE FUNCTION record_vault_performance();
-- Backfill existing v2 snapshots only; legacy performance remains unchanged.
INSERT INTO vault_performance_rollups(fund_id,interval_seconds,bucket_at,priced_at,source_created_at,event_sequence,nav_usdc,share_price_usdc)
SELECT DISTINCT ON (n.fund_id,s.seconds,to_timestamp(floor(extract(epoch FROM n.priced_at)/s.seconds)*s.seconds))
 n.fund_id,s.seconds,to_timestamp(floor(extract(epoch FROM n.priced_at)/s.seconds)*s.seconds),n.priced_at,n.created_at,COALESCE(n.event_sequence,0),n.nav_usdc,n.share_price_usdc
 FROM nav_snapshots n JOIN vault_rounds r ON r.fund_id=n.fund_id CROSS JOIN (VALUES(3600),(86400)) s(seconds)
 WHERE n.status='CURRENT' AND n.priced_at IS NOT NULL AND n.nav_usdc IS NOT NULL AND n.share_price_usdc IS NOT NULL AND n.priced_at<=clock_timestamp()+interval '5 seconds'
 ORDER BY n.fund_id,s.seconds,to_timestamp(floor(extract(epoch FROM n.priced_at)/s.seconds)*s.seconds),n.event_sequence DESC NULLS LAST,n.created_at DESC;
