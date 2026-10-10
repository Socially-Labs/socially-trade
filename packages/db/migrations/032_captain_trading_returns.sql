-- Economic unit-price returns, isolated from money and from the AUM chart.
-- Only round-v2: at most one open round per Captain under existing creation rules.
CREATE TABLE captain_return_state (
 captain_id uuid PRIMARY KEY REFERENCES users(id), inception_at timestamptz NOT NULL, index_value numeric NOT NULL DEFAULT 100 CHECK(index_value>=0)
);
CREATE TABLE fund_return_state (
 fund_id uuid PRIMARY KEY REFERENCES funds(id), last_sequence bigint NOT NULL DEFAULT -1,
 last_snapshot uuid, last_unit_price numeric NOT NULL DEFAULT 1 CHECK(last_unit_price>=0)
);
CREATE TABLE captain_return_rollups (
 captain_id uuid NOT NULL REFERENCES users(id), interval_seconds integer NOT NULL CHECK(interval_seconds IN (3600,86400)),
 bucket_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL, index_value numeric CHECK(index_value>=0),
 has_gap boolean NOT NULL DEFAULT false, PRIMARY KEY(captain_id,interval_seconds,bucket_at)
);
CREATE FUNCTION capture_captain_return(snapshot uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n record; previous fund_return_state; current_index numeric; next_index numeric; seconds integer; gap boolean;
BEGIN
 SELECT ns.*,f.captain_id INTO n FROM nav_snapshots ns JOIN funds f ON f.id=ns.fund_id
 WHERE ns.id=snapshot AND f.round_model_version=2;
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO captain_return_state(captain_id,inception_at) VALUES(n.captain_id,n.created_at) ON CONFLICT DO NOTHING;
 SELECT index_value INTO current_index FROM captain_return_state WHERE captain_id=n.captain_id FOR UPDATE;
 INSERT INTO fund_return_state(fund_id) VALUES(n.fund_id) ON CONFLICT DO NOTHING;
 SELECT * INTO previous FROM fund_return_state WHERE fund_id=n.fund_id FOR UPDATE;
 IF COALESCE(n.event_sequence,0)<previous.last_sequence OR n.id=previous.last_snapshot THEN RETURN; END IF;
 gap:=EXISTS(SELECT 1 FROM funds f JOIN vault_rounds r ON r.fund_id=f.id WHERE f.captain_id=n.captain_id AND f.id<>n.fund_id AND r.funding_started_at<=n.created_at AND (r.finalized_at IS NULL OR r.finalized_at>=n.created_at)) OR n.status<>'CURRENT' OR n.share_price_usdc IS NULL OR n.share_price_usdc<0 OR n.priced_at>clock_timestamp()+interval '5 seconds';
 IF NOT gap THEN
   IF previous.last_unit_price=0 THEN
     next_index:=CASE WHEN n.share_price_usdc=0 THEN current_index ELSE NULL END;
     gap:=next_index IS NULL;
   ELSE next_index:=current_index*n.share_price_usdc/previous.last_unit_price; END IF;
 END IF;
 IF NOT gap THEN
   UPDATE captain_return_state SET index_value=next_index WHERE captain_id=n.captain_id;
   UPDATE fund_return_state SET last_unit_price=n.share_price_usdc,last_sequence=COALESCE(n.event_sequence,0),last_snapshot=n.id WHERE fund_id=n.fund_id;
 END IF;
 FOREACH seconds IN ARRAY ARRAY[3600,86400] LOOP
   INSERT INTO captain_return_rollups(captain_id,interval_seconds,bucket_at,recorded_at,index_value,has_gap)
   VALUES(n.captain_id,seconds,to_timestamp(floor(extract(epoch FROM n.created_at)/seconds)*seconds),n.created_at,CASE WHEN gap THEN NULL ELSE next_index END,gap)
   ON CONFLICT(captain_id,interval_seconds,bucket_at) DO UPDATE SET recorded_at=EXCLUDED.recorded_at,index_value=EXCLUDED.index_value,
     has_gap=captain_return_rollups.has_gap OR EXCLUDED.has_gap WHERE EXCLUDED.recorded_at>=captain_return_rollups.recorded_at;
 END LOOP;
END $$;
CREATE FUNCTION record_captain_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM capture_captain_return(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER captain_return_snapshot AFTER INSERT ON nav_snapshots FOR EACH ROW EXECUTE FUNCTION record_captain_return();
-- Replay recorded snapshots, without inventing prehistory or changing financial evidence.
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT n.id FROM nav_snapshots n JOIN funds f ON f.id=n.fund_id WHERE f.round_model_version=2 ORDER BY f.captain_id,n.created_at,n.event_sequence NULLS FIRST,n.id
 LOOP PERFORM capture_captain_return(item.id); END LOOP;
END $$;
