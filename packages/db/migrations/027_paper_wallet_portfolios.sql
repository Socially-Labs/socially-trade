-- Virtual capital is never treasury-backed cash and cannot be redeemed onchain.
ALTER TABLE users ADD COLUMN vault_paper_cash numeric(38,18) NOT NULL DEFAULT 0 CHECK (vault_paper_cash >= 0);
ALTER TABLE vault_rounds ADD COLUMN balance_source text NOT NULL DEFAULT 'LEGACY' CHECK (balance_source IN ('LEGACY','WALLET_SNAPSHOT'));
CREATE FUNCTION preserve_vault_balance_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.balance_source IS DISTINCT FROM OLD.balance_source THEN
  RAISE EXCEPTION 'vault balance source is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vault_balance_source_immutable BEFORE UPDATE ON vault_rounds
 FOR EACH ROW EXECUTE FUNCTION preserve_vault_balance_source();
CREATE TABLE paper_wallet_snapshots (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 wallet_address text NOT NULL UNIQUE,
 sol_lamports numeric(20,0) NOT NULL CHECK (sol_lamports >= 0),
 usdc_raw numeric(20,0) NOT NULL CHECK (usdc_raw >= 0),
 sol_price_usd numeric(38,18),
 usdc_price_usd numeric(38,18),
 initial_usdc numeric(38,6) NOT NULL CHECK (initial_usdc > 0),
 observed_slot bigint NOT NULL,
 event_id uuid NOT NULL UNIQUE REFERENCES fund_events(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
