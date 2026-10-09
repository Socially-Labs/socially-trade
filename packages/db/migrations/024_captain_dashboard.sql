-- Captain dashboard read models. Money remains in vault contributions/claims;
-- these buckets describe managed assets, never a spendable balance.
CREATE INDEX captain_rounds_by_owner ON funds(captain_id,id) WHERE round_model_version=2;
CREATE INDEX captain_claim_history ON vault_claims(user_id,paid_at,fund_id);
CREATE INDEX captain_crew_allocations ON vault_contributions(fund_id,user_id) INCLUDE(amount_usdc,event_id) WHERE state='ACCEPTED';

CREATE TABLE captain_vault_aum_rollups (
  fund_id uuid NOT NULL REFERENCES vault_rounds(fund_id),
  interval_seconds integer NOT NULL CHECK(interval_seconds IN (3600,86400)),
  bucket_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  nav_usdc numeric(38,18) CHECK(nav_usdc>=0),
  valuation_status text NOT NULL CHECK(valuation_status IN ('CURRENT','UNAVAILABLE')),
  PRIMARY KEY(fund_id,interval_seconds,bucket_at),
  CHECK((valuation_status='CURRENT')=(nav_usdc IS NOT NULL))
);
CREATE FUNCTION capture_captain_vault_aum(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_phase text; mark record; amount numeric; state text; seconds integer; captured timestamptz := clock_timestamp();
BEGIN
 SELECT phase INTO current_phase FROM vault_rounds WHERE fund_id=target;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT n.status,n.nav_usdc,n.priced_at INTO mark FROM nav_snapshots n WHERE n.fund_id=target
 ORDER BY n.event_sequence DESC NULLS LAST,n.created_at DESC,n.id DESC LIMIT 1;
 IF current_phase IN ('COMPLETED','CANCELLED') THEN amount:=0; state:='CURRENT';
 ELSIF current_phase IN ('SETTLING','REFUNDING') OR mark.status IS DISTINCT FROM 'CURRENT'
   OR mark.nav_usdc IS NULL OR mark.priced_at IS NULL OR mark.priced_at>captured+interval '5 seconds'
   OR (mark.priced_at<captured-interval '90 seconds' AND EXISTS(SELECT 1 FROM positions WHERE fund_id=target AND quantity>0))
 THEN amount:=NULL; state:='UNAVAILABLE';
 ELSE amount:=mark.nav_usdc; state:='CURRENT'; END IF;
 FOREACH seconds IN ARRAY ARRAY[3600,86400] LOOP
  INSERT INTO captain_vault_aum_rollups(fund_id,interval_seconds,bucket_at,recorded_at,nav_usdc,valuation_status)
  VALUES(target,seconds,to_timestamp(floor(extract(epoch FROM captured)/seconds)*seconds),captured,amount,state)
  ON CONFLICT(fund_id,interval_seconds,bucket_at) DO UPDATE SET
   recorded_at=EXCLUDED.recorded_at,nav_usdc=EXCLUDED.nav_usdc,valuation_status=EXCLUDED.valuation_status
  WHERE EXCLUDED.recorded_at>=captain_vault_aum_rollups.recorded_at;
 END LOOP;
END $$;
CREATE FUNCTION record_captain_vault_aum() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM capture_captain_vault_aum(NEW.fund_id);
 RETURN NEW;
END $$;
CREATE TRIGGER captain_aum_snapshot AFTER INSERT ON nav_snapshots FOR EACH ROW EXECUTE FUNCTION record_captain_vault_aum();
CREATE TRIGGER captain_aum_phase AFTER UPDATE OF phase ON vault_rounds FOR EACH ROW
 WHEN(OLD.phase IS DISTINCT FROM NEW.phase) EXECUTE FUNCTION record_captain_vault_aum();

-- Restore recorded history without inventing values between marks. Settlement is
-- a zero managed-assets point, even when proceeds have not yet been claimed.
INSERT INTO captain_vault_aum_rollups(fund_id,interval_seconds,bucket_at,recorded_at,nav_usdc,valuation_status)
SELECT DISTINCT ON(n.fund_id,s.seconds,to_timestamp(floor(extract(epoch FROM n.created_at)/s.seconds)*s.seconds))
 n.fund_id,s.seconds,to_timestamp(floor(extract(epoch FROM n.created_at)/s.seconds)*s.seconds),n.created_at,
 CASE WHEN r.finalized_at<=n.created_at THEN 0 WHEN n.status='CURRENT' AND n.nav_usdc IS NOT NULL AND n.priced_at<=n.created_at+interval '5 seconds' THEN n.nav_usdc ELSE NULL END,
 CASE WHEN r.finalized_at<=n.created_at OR (n.status='CURRENT' AND n.nav_usdc IS NOT NULL AND n.priced_at<=n.created_at+interval '5 seconds') THEN 'CURRENT' ELSE 'UNAVAILABLE' END
FROM nav_snapshots n JOIN vault_rounds r ON r.fund_id=n.fund_id CROSS JOIN(VALUES(3600),(86400)) s(seconds)
ORDER BY n.fund_id,s.seconds,to_timestamp(floor(extract(epoch FROM n.created_at)/s.seconds)*s.seconds),n.event_sequence DESC NULLS LAST,n.created_at DESC,n.id DESC;
INSERT INTO captain_vault_aum_rollups(fund_id,interval_seconds,bucket_at,recorded_at,nav_usdc,valuation_status)
SELECT fund_id,s.seconds,to_timestamp(floor(extract(epoch FROM finalized_at)/s.seconds)*s.seconds),finalized_at,0,'CURRENT'
FROM vault_rounds CROSS JOIN(VALUES(3600),(86400)) s(seconds) WHERE finalized_at IS NOT NULL
ON CONFLICT(fund_id,interval_seconds,bucket_at) DO UPDATE SET
 recorded_at=EXCLUDED.recorded_at,nav_usdc=0,valuation_status='CURRENT'
 WHERE EXCLUDED.recorded_at>=captain_vault_aum_rollups.recorded_at;

-- Shared live read model used by overview and earnings. Terminal rounds contribute
-- no AUM; stale/missing marks remain NULL rather than pretending to be zero.
CREATE VIEW captain_vault_metrics AS
SELECT f.id,f.captain_id,f.name,r.phase,r.funding_started_at,r.finalized_at,
 r.accepted_capital_usdc,r.captain_fee_usdc,
 CASE WHEN r.phase IN ('COMPLETED','CANCELLED') THEN 0
 WHEN r.phase IN ('SETTLING','REFUNDING') THEN NULL
 WHEN n.status='CURRENT' AND n.priced_at<=clock_timestamp()+interval '5 seconds'
 AND (n.priced_at>=clock_timestamp()-interval '90 seconds' OR NOT EXISTS(SELECT 1 FROM positions p WHERE p.fund_id=f.id AND p.quantity>0))
 THEN n.nav_usdc ELSE NULL END AS managed_usdc,
 COALESCE(c.captain_fee_usdc,0) AS claimed_fee_usdc,c.paid_at,
 (SELECT count(DISTINCT vc.user_id)::integer FROM vault_contributions vc WHERE vc.fund_id=f.id AND vc.state='ACCEPTED' AND vc.user_id<>f.captain_id) AS crew_count
FROM funds f JOIN vault_rounds r ON r.fund_id=f.id
LEFT JOIN vault_claims c ON c.fund_id=f.id AND c.user_id=f.captain_id
LEFT JOIN LATERAL(SELECT nav_usdc,status,priced_at FROM nav_snapshots WHERE fund_id=f.id
 ORDER BY event_sequence DESC NULLS LAST,created_at DESC,id DESC LIMIT 1) n ON true;
