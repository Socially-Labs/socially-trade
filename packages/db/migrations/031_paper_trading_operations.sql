-- Coalesced durable valuation work. Claims commit before taking a fund lock.
CREATE TABLE fund_valuation_jobs (
 fund_id uuid PRIMARY KEY REFERENCES funds(id), generation bigint NOT NULL DEFAULT 1,
 next_run_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, reason text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX valuation_jobs_due ON fund_valuation_jobs(next_run_at);
CREATE TABLE paper_job_sweeps (
 name text PRIMARY KEY, cursor_id uuid, upper_id uuid, next_run_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO paper_job_sweeps(name) VALUES('valuation'),('reconciliation');
CREATE FUNCTION queue_market_valuations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO fund_valuation_jobs(fund_id,reason)
 SELECT p.fund_id,'market_changed' FROM positions p JOIN funds f ON f.id=p.fund_id
 WHERE p.instrument_id=NEW.instrument_id AND p.quantity>0 AND f.status IN ('ACTIVE','FROZEN')
 ON CONFLICT(fund_id) DO UPDATE SET generation=fund_valuation_jobs.generation+1,
   next_run_at=least(fund_valuation_jobs.next_run_at,now()),reason=EXCLUDED.reason,updated_at=now();
 RETURN NEW;
END $$;
CREATE TRIGGER market_valuation_work AFTER INSERT OR UPDATE ON market_latest FOR EACH ROW EXECUTE FUNCTION queue_market_valuations();
CREATE FUNCTION queue_position_valuation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO fund_valuation_jobs(fund_id,reason) VALUES(NEW.fund_id,'position_changed')
 ON CONFLICT(fund_id) DO UPDATE SET generation=fund_valuation_jobs.generation+1,
   next_run_at=least(fund_valuation_jobs.next_run_at,now()),updated_at=now();
 RETURN NEW;
END $$;
CREATE TRIGGER position_valuation_work AFTER INSERT OR UPDATE OF quantity ON positions FOR EACH ROW EXECUTE FUNCTION queue_position_valuation();

-- Durable Captain invalidations, updated in the same transaction as fund events.
CREATE TABLE captain_change_state (
 captain_id uuid PRIMARY KEY REFERENCES users(id), revision bigint NOT NULL DEFAULT 0,
 event_id uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION record_captain_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO captain_change_state(captain_id,revision,event_id)
 SELECT captain_id,1,NEW.id FROM funds WHERE id=NEW.fund_id
 ON CONFLICT(captain_id) DO UPDATE SET revision=captain_change_state.revision+1,event_id=EXCLUDED.event_id,updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER captain_committed_change AFTER INSERT ON fund_events FOR EACH ROW EXECUTE FUNCTION record_captain_change();
INSERT INTO captain_change_state(captain_id,revision) SELECT captain_id,COALESCE(sum(event_sequence),0) FROM funds GROUP BY captain_id;

-- Progress is operational evidence, never an alternative order status or a fill.
ALTER TABLE orders ADD COLUMN progress_state text NOT NULL DEFAULT 'WAITING_DELAY'
 CHECK(progress_state IN ('WAITING_DELAY','WAITING_PRICE','WAITING_VALUATION','READY','FILLED','REJECTED','CANCELLED'));
ALTER TABLE orders ADD COLUMN progress_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE orders ADD COLUMN last_attempted_at timestamptz;
ALTER TABLE orders ADD COLUMN execution_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN waiting_observation_id uuid REFERENCES price_observations(id);
UPDATE orders SET progress_state=status WHERE status IN ('FILLED','REJECTED','CANCELLED');
CREATE INDEX pending_orders_fair ON orders(last_attempted_at NULLS FIRST,submitted_at) WHERE status='PENDING';
CREATE INDEX ledger_entries_by_account ON ledger_entries(account_id,id);
CREATE TABLE paper_reconciliation_state (
 fund_id uuid PRIMARY KEY REFERENCES funds(id), checked_revision bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('HEALTHY','MISMATCH')), checked_at timestamptz NOT NULL DEFAULT now(),
 findings jsonb NOT NULL DEFAULT '[]', mismatch_since timestamptz
);
CREATE TABLE paper_reconciliation_incidents (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, fund_id uuid NOT NULL REFERENCES funds(id),
 detected_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 checked_revision bigint NOT NULL, findings jsonb NOT NULL
);
CREATE UNIQUE INDEX reconciliation_open_incident ON paper_reconciliation_incidents(fund_id) WHERE resolved_at IS NULL;

-- Strict shared history admission. Count-and-insert alone races across replicas.
CREATE TABLE market_history_admission(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton));
INSERT INTO market_history_admission DEFAULT VALUES;
CREATE FUNCTION enqueue_market_history(k text,i text,f timestamptz,t timestamptz,r integer) RETURNS text LANGUAGE plpgsql AS $$
DECLARE existing market_history_jobs;
BEGIN
 PERFORM 1 FROM market_history_admission WHERE singleton FOR UPDATE;
 SELECT * INTO existing FROM market_history_jobs WHERE work_key=k;
 IF FOUND AND NOT(existing.status='UNAVAILABLE' AND existing.next_run_at<=now()) THEN RETURN k; END IF;
 IF (SELECT count(*) FROM market_history_jobs WHERE status IN ('PENDING','RUNNING'))>=200 THEN RETURN NULL; END IF;
 INSERT INTO market_history_jobs(work_key,instrument_id,source,resolution_seconds,from_at,to_at)
 VALUES(k,i,'BIRDEYE_TOKEN_USD',r,f,t)
 ON CONFLICT(work_key) DO UPDATE SET status='PENDING',attempts=0,last_error=NULL,next_run_at=now();
 RETURN k;
END $$;
ALTER TABLE market_history_jobs ADD COLUMN empty_coverage boolean NOT NULL DEFAULT false;
