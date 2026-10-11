-- Versioned investment analytics. Never use AUM's terminal zero as a loss.
-- The legacy sequential-round return contract remains unchanged.
CREATE TABLE captain_portfolio_state (
 captain_id uuid PRIMARY KEY REFERENCES users(id), revision bigint NOT NULL DEFAULT 0,
 inception_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL,
 index_value numeric, chain_id bigint NOT NULL DEFAULT 0
);
CREATE TABLE vault_portfolio_state (
 fund_id uuid PRIMARY KEY REFERENCES funds(id), captain_id uuid NOT NULL REFERENCES users(id),
 snapshot_id uuid NOT NULL REFERENCES nav_snapshots(id), event_sequence bigint NOT NULL,
 recorded_at timestamptz NOT NULL, priced_at timestamptz NOT NULL,
 economic_nav_usdc numeric, capital_usdc numeric NOT NULL,
 terminal boolean NOT NULL, has_exposure boolean NOT NULL
);
CREATE INDEX vault_portfolio_captain ON vault_portfolio_state(captain_id,fund_id);
-- Exact boundary evidence is retained separately from display downsampling.
CREATE TABLE captain_portfolio_observations (
 captain_id uuid NOT NULL REFERENCES users(id), revision bigint NOT NULL,
 recorded_at timestamptz NOT NULL, source_fund_id uuid NOT NULL REFERENCES funds(id),
 source_fund_pnl_usdc numeric, cumulative_pnl_usdc numeric, index_value numeric,
 source_unit_price numeric, net_flows_usdc numeric NOT NULL,
 chain_id bigint NOT NULL, has_gap boolean NOT NULL,
 PRIMARY KEY(captain_id,revision)
);
CREATE INDEX captain_portfolio_boundary ON captain_portfolio_observations(captain_id,recorded_at DESC,revision DESC);
CREATE INDEX vault_portfolio_boundary ON captain_portfolio_observations(source_fund_id,recorded_at DESC,revision DESC);
CREATE TABLE captain_portfolio_rollups (
 captain_id uuid NOT NULL REFERENCES users(id), interval_seconds integer NOT NULL CHECK(interval_seconds IN (3600,86400)),
 bucket_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL, revision bigint NOT NULL,
 aum_usdc numeric, cumulative_pnl_usdc numeric, settled_pnl_usdc numeric NOT NULL,
 net_flows_usdc numeric NOT NULL, index_value numeric, chain_id bigint NOT NULL,
 has_gap boolean NOT NULL, PRIMARY KEY(captain_id,interval_seconds,bucket_at)
);

CREATE FUNCTION capture_captain_portfolio(snapshot uuid, replay boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n record; previous vault_portfolio_state; portfolio captain_portfolio_state;
 capital numeric; terminal boolean; nav numeric; exposure boolean; at timestamptz;
 old_aum numeric; old_flows numeric; aum numeric; flows numeric; pnl numeric; settled numeric;
 invalid boolean; next_index numeric; next_chain bigint; seconds integer;
BEGIN
 SELECT ns.*,f.captain_id,r.finalized_at,r.distribution_pool_usdc INTO n
 FROM nav_snapshots ns JOIN funds f ON f.id=ns.fund_id JOIN vault_rounds r ON r.fund_id=f.id
 WHERE ns.id=snapshot AND f.round_model_version=2;
 IF NOT FOUND THEN RETURN; END IF;
 -- Fund writers already hold their fund lock. Only this Captain's projection is
 -- serialized here; peer funds are read without acquiring their financial locks.
 INSERT INTO captain_portfolio_state(captain_id,inception_at,recorded_at,index_value)
 VALUES(n.captain_id,n.created_at,n.created_at,100) ON CONFLICT DO NOTHING;
 SELECT * INTO portfolio FROM captain_portfolio_state WHERE captain_id=n.captain_id FOR UPDATE;
 SELECT * INTO previous FROM vault_portfolio_state WHERE fund_id=n.fund_id;
 IF previous.snapshot_id=n.id OR previous.event_sequence>=COALESCE(n.event_sequence,0) THEN RETURN; END IF;
 at:=GREATEST(n.created_at,portfolio.recorded_at);
 -- Contribution rows exist before NAV, operations rows do not. Reconstruct the
 -- principal at this sequence even if a contribution was cancelled later.
 SELECT COALESCE(sum(c.amount_usdc) FILTER(WHERE deposited.sequence<=COALESCE(n.event_sequence,0)
   AND (cancelled.sequence IS NULL OR cancelled.sequence>COALESCE(n.event_sequence,0))),0)
 INTO capital FROM vault_contributions c JOIN fund_events deposited ON deposited.id=c.event_id
 LEFT JOIN fund_events cancelled ON cancelled.id=c.cancelled_event_id WHERE c.fund_id=n.fund_id;
 terminal:=n.finalized_at IS NOT NULL AND n.priced_at>=n.finalized_at;
 -- Exposure was not recorded on legacy snapshots. Replay uses conservative
 -- peer-mark freshness instead of pretending to know historical holdings.
 exposure:=NOT terminal AND (replay OR EXISTS(SELECT 1 FROM positions WHERE fund_id=n.fund_id AND quantity>0));
 nav:=CASE WHEN terminal THEN n.distribution_pool_usdc
   WHEN n.status='CURRENT' AND n.nav_usdc>=0 AND n.priced_at<=n.created_at+interval '5 seconds'
     AND (NOT exposure OR n.priced_at>=n.created_at-interval '90 seconds') THEN n.nav_usdc ELSE NULL END;
 SELECT COALESCE(sum(CASE WHEN s.terminal THEN 0 ELSE s.economic_nav_usdc END),0),
   COALESCE(sum(s.capital_usdc-CASE WHEN s.terminal THEN s.economic_nav_usdc ELSE 0 END),0)
 INTO old_aum,old_flows FROM vault_portfolio_state s WHERE s.captain_id=n.captain_id;
 INSERT INTO vault_portfolio_state(fund_id,captain_id,snapshot_id,event_sequence,recorded_at,priced_at,economic_nav_usdc,capital_usdc,terminal,has_exposure)
 VALUES(n.fund_id,n.captain_id,n.id,COALESCE(n.event_sequence,0),at,n.priced_at,nav,capital,terminal,exposure)
 ON CONFLICT(fund_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,event_sequence=EXCLUDED.event_sequence,
 recorded_at=EXCLUDED.recorded_at,priced_at=EXCLUDED.priced_at,economic_nav_usdc=EXCLUDED.economic_nav_usdc,
 capital_usdc=EXCLUDED.capital_usdc,terminal=EXCLUDED.terminal,has_exposure=EXCLUDED.has_exposure;
 SELECT bool_or(s.economic_nav_usdc IS NULL OR (NOT s.terminal AND s.has_exposure AND s.priced_at<at-interval '90 seconds')),
   sum(CASE WHEN s.terminal THEN 0 ELSE s.economic_nav_usdc END),sum(s.economic_nav_usdc-s.capital_usdc),
   COALESCE(sum(s.economic_nav_usdc-s.capital_usdc) FILTER(WHERE s.terminal),0),
   sum(s.capital_usdc-CASE WHEN s.terminal THEN s.economic_nav_usdc ELSE 0 END)
 INTO invalid,aum,pnl,settled,flows FROM vault_portfolio_state s WHERE s.captain_id=n.captain_id;
 next_chain:=portfolio.chain_id;
 IF invalid THEN next_index:=NULL;
 ELSIF portfolio.index_value IS NULL THEN
   -- A new independently comparable segment; never bridge unknown valuations.
   next_chain:=next_chain+1; next_index:=100;
 ELSIF old_aum>0 THEN
   next_index:=trunc(portfolio.index_value*(aum-(flows-old_flows))/old_aum,24);
   IF next_index<0 THEN next_index:=NULL; invalid:=true; END IF;
 ELSIF aum=flows-old_flows THEN
   IF portfolio.index_value=0 AND aum>0 THEN next_chain:=next_chain+1; next_index:=100;
   ELSE next_index:=portfolio.index_value; END IF;
 ELSE next_index:=NULL; invalid:=true;
 END IF;
 UPDATE captain_portfolio_state SET revision=revision+1,recorded_at=at,index_value=next_index,chain_id=next_chain
 WHERE captain_id=n.captain_id RETURNING * INTO portfolio;
 INSERT INTO captain_portfolio_observations(captain_id,revision,recorded_at,source_fund_id,source_fund_pnl_usdc,
   cumulative_pnl_usdc,index_value,source_unit_price,net_flows_usdc,chain_id,has_gap)
 VALUES(n.captain_id,portfolio.revision,at,n.fund_id,nav-capital,
   CASE WHEN invalid THEN NULL ELSE pnl END,next_index,nav/NULLIF(capital,0),flows,next_chain,invalid);
 FOREACH seconds IN ARRAY ARRAY[3600,86400] LOOP
   INSERT INTO captain_portfolio_rollups VALUES(n.captain_id,seconds,to_timestamp(floor(extract(epoch FROM at)/seconds)*seconds),at,portfolio.revision,
     CASE WHEN invalid THEN NULL ELSE aum END,CASE WHEN invalid THEN NULL ELSE pnl END,settled,flows,next_index,next_chain,invalid)
   ON CONFLICT(captain_id,interval_seconds,bucket_at) DO UPDATE SET recorded_at=EXCLUDED.recorded_at,revision=EXCLUDED.revision,
     aum_usdc=EXCLUDED.aum_usdc,cumulative_pnl_usdc=EXCLUDED.cumulative_pnl_usdc,settled_pnl_usdc=EXCLUDED.settled_pnl_usdc,
     net_flows_usdc=EXCLUDED.net_flows_usdc,index_value=EXCLUDED.index_value,chain_id=EXCLUDED.chain_id,
     has_gap=captain_portfolio_rollups.has_gap OR EXCLUDED.has_gap;
 END LOOP;
END $$;
CREATE FUNCTION record_captain_portfolio() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM capture_captain_portfolio(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER captain_portfolio_snapshot AFTER INSERT ON nav_snapshots FOR EACH ROW EXECUTE FUNCTION record_captain_portfolio();
-- Deterministic replay of existing financial evidence; no synthetic prehistory.
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT n.id FROM nav_snapshots n JOIN funds f ON f.id=n.fund_id WHERE f.round_model_version=2
   ORDER BY n.created_at,n.event_sequence NULLS FIRST,n.id
 LOOP PERFORM capture_captain_portfolio(item.id,true); END LOOP;
END $$;
