-- Deploy with workers paused. Existing unreserved pending intents are cancelled with audit events.
ALTER TABLE orders ADD COLUMN reserved_cash_usdc numeric(38,6) NOT NULL DEFAULT 0 CHECK(reserved_cash_usdc>=0),
  ADD COLUMN reserved_quantity numeric(38,18) NOT NULL DEFAULT 0 CHECK(reserved_quantity>=0);
CREATE INDEX orders_pending_reservations_idx ON orders(fund_id,instrument_id) WHERE status='PENDING';
DO $$ DECLARE r record; seq bigint; event uuid;
BEGIN
 FOR r IN SELECT id,fund_id FROM orders WHERE status='PENDING' ORDER BY fund_id,id LOOP
  UPDATE orders SET status='CANCELLED',progress_state='CANCELLED',processed_at=clock_timestamp(),reject_reason='reservation_migration' WHERE id=r.id;
  UPDATE funds SET event_sequence=event_sequence+1 WHERE id=r.fund_id RETURNING event_sequence INTO seq;
  event=gen_random_uuid();
  INSERT INTO fund_events(id,fund_id,sequence,type,payload) VALUES(event,r.fund_id,seq,'order_cancelled',jsonb_build_object('orderId',r.id,'reason','reservation_migration'));
  INSERT INTO outbox_events(id,fund_event_id,type,payload) VALUES(gen_random_uuid(),event,'order_cancelled',jsonb_build_object('orderId',r.id,'reason','reservation_migration'));
 END LOOP;
END $$;
ALTER TABLE price_observations ADD COLUMN last_confirmed_at timestamptz;
ALTER TABLE fills ADD COLUMN model_parameters jsonb, ADD COLUMN realized_pnl_usdc numeric(38,18), ADD COLUMN cost_basis_sold_usdc numeric(38,18);
-- Do not round historical balances silently. New writes enforce cash precision; reconciliation audits existing rows.
ALTER TABLE users ADD CONSTRAINT paper_cash_precision CHECK(paper_cash=trunc(paper_cash,6)) NOT VALID,
  ADD CONSTRAINT vault_paper_cash_precision CHECK(vault_paper_cash=trunc(vault_paper_cash,6)) NOT VALID;
ALTER TABLE funds ADD CONSTRAINT fund_cash_precision CHECK(cash_usdc=trunc(cash_usdc,6)) NOT VALID;
CREATE TABLE paper_service_heartbeats(service text PRIMARY KEY CHECK(service IN ('worker','ingestor')),instance_id uuid NOT NULL,completed_at timestamptz NOT NULL);
CREATE TABLE paper_user_reconciliation_state(user_id uuid PRIMARY KEY REFERENCES users(id),status text NOT NULL CHECK(status IN ('HEALTHY','MISMATCH')),findings jsonb NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),mismatch_since timestamptz);
CREATE TABLE paper_user_reconciliation_incidents(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),findings jsonb NOT NULL,opened_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz);
CREATE UNIQUE INDEX paper_user_incident_open_idx ON paper_user_reconciliation_incidents(user_id) WHERE resolved_at IS NULL;
INSERT INTO paper_job_sweeps(name,next_run_at) VALUES('user_reconciliation',now()) ON CONFLICT DO NOTHING;

-- The synthetic fill model has no upstream liquidity estimate.
ALTER TABLE price_observations DROP COLUMN liquidity_usdc;
