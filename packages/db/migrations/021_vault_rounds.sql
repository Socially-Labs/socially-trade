-- Additive round-v2. No trial row is created for these funds; old parsers remain isolated.
ALTER TABLE funds ADD COLUMN round_model_version smallint NOT NULL DEFAULT 1
  CHECK (round_model_version IN (1,2));
CREATE TABLE vault_rounds (
  fund_id uuid PRIMARY KEY REFERENCES funds(id),
  terms_version integer NOT NULL CHECK (terms_version=1),
  fee_model_version integer NOT NULL DEFAULT 2 CHECK (fee_model_version=2),
  terms jsonb NOT NULL,
  terms_hash text NOT NULL CHECK (terms_hash ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL CHECK (phase IN ('FUNDRAISING','ACTIVE','SETTLING','COMPLETED','REFUNDING','CANCELLED')),
  funding_window_hours integer NOT NULL CHECK (funding_window_hours IN (12,24,72)),
  duration_days integer NOT NULL CHECK (duration_days IN (3,7,14,21,28,30,60,90,180,365)),
  funding_started_at timestamptz NOT NULL,
  funding_closes_at timestamptz NOT NULL,
  trading_ends_at timestamptz NOT NULL,
  actual_activated_at timestamptz,
  accepted_capital_usdc numeric(30,6) NOT NULL CHECK (accepted_capital_usdc BETWEEN 0 AND 30000),
  final_supply numeric(30,6) CHECK (final_supply>0),
  final_assets_usdc numeric(30,6) CHECK (final_assets_usdc>=0),
  distribution_pool_usdc numeric(30,6) CHECK (distribution_pool_usdc>=0),
  captain_fee_usdc numeric(30,6) CHECK (captain_fee_usdc>=0),
  residue_liability_usdc numeric(30,6) CHECK (residue_liability_usdc>=0),
  finalized_at timestamptz,
  transition_version bigint NOT NULL DEFAULT 0 CHECK (transition_version>=0),
  blocked_reason text,
  last_attempted_at timestamptz,
  risk_state text NOT NULL DEFAULT 'NORMAL' CHECK (risk_state IN ('NORMAL','FROZEN')),
  CHECK (funding_closes_at = funding_started_at + funding_window_hours * interval '1 hour'),
  CHECK (trading_ends_at = funding_closes_at + duration_days * interval '24 hours'),
  CHECK ((phase IN ('COMPLETED','CANCELLED')) = (finalized_at IS NOT NULL)),
  CHECK ((finalized_at IS NULL) = (final_supply IS NULL)),
  CHECK ((finalized_at IS NULL) = (distribution_pool_usdc IS NULL)),
  CHECK ((finalized_at IS NULL) = (captain_fee_usdc IS NULL)),
  CHECK ((finalized_at IS NULL) = (final_assets_usdc IS NULL)),
  CHECK ((finalized_at IS NULL) = (residue_liability_usdc IS NULL))
);
CREATE INDEX vault_rounds_due_funding ON vault_rounds(funding_closes_at,fund_id) WHERE phase='FUNDRAISING';
CREATE INDEX vault_rounds_due_trading ON vault_rounds(trading_ends_at,fund_id) WHERE phase='ACTIVE';
CREATE INDEX vault_rounds_settling ON vault_rounds(fund_id) WHERE phase IN ('SETTLING','REFUNDING');
CREATE INDEX vault_rounds_discover ON vault_rounds(phase,duration_days,fund_id);
CREATE TABLE vault_contributions (
  id uuid PRIMARY KEY,
  fund_id uuid NOT NULL REFERENCES vault_rounds(fund_id),
  user_id uuid NOT NULL REFERENCES users(id),
  amount_usdc numeric(30,6) NOT NULL CHECK (amount_usdc>0),
  state text NOT NULL DEFAULT 'ACCEPTED' CHECK (state IN ('ACCEPTED','CANCELLED')),
  event_id uuid NOT NULL UNIQUE REFERENCES fund_events(id),
  cancelled_event_id uuid REFERENCES fund_events(id),
  CHECK ((state='CANCELLED') = (cancelled_event_id IS NOT NULL))
);
CREATE INDEX vault_contributions_member ON vault_contributions(fund_id,user_id,state);
CREATE TABLE vault_operations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL,
  fund_id uuid NOT NULL REFERENCES vault_rounds(fund_id),
  kind text NOT NULL CHECK (kind IN ('CREATE','CONTRIBUTE','CANCEL','CLAIM')),
  event_id uuid NOT NULL UNIQUE REFERENCES fund_events(id),
  amount_usdc numeric(30,6) NOT NULL CHECK (amount_usdc>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,client_request_id)
);
CREATE TABLE vault_claims (
  fund_id uuid NOT NULL REFERENCES vault_rounds(fund_id),
  user_id uuid NOT NULL REFERENCES users(id),
  investment_usdc numeric(30,6) NOT NULL CHECK (investment_usdc>=0),
  captain_fee_usdc numeric(30,6) NOT NULL CHECK (captain_fee_usdc>=0),
  operation_id uuid NOT NULL UNIQUE REFERENCES vault_operations(id),
  paid_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(fund_id,user_id)
);
-- Fund locks serialize all round writes. Existing partial unique index includes fundraising
-- (FROZEN), ACTIVE and SETTLING; completed rounds with unclaimed cash release capacity.
CREATE FUNCTION protect_vault_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.terms,NEW.terms_hash,NEW.terms_version,NEW.fee_model_version,
      NEW.funding_window_hours,NEW.duration_days,NEW.funding_started_at,NEW.funding_closes_at,NEW.trading_ends_at)
     IS DISTINCT FROM
     (OLD.terms,OLD.terms_hash,OLD.terms_version,OLD.fee_model_version,
      OLD.funding_window_hours,OLD.duration_days,OLD.funding_started_at,OLD.funding_closes_at,OLD.trading_ends_at) THEN
    RAISE EXCEPTION 'Vault financial terms are immutable';
  END IF;
  IF NEW.phase IS DISTINCT FROM OLD.phase AND NOT (
    (OLD.phase='FUNDRAISING' AND NEW.phase IN ('ACTIVE','SETTLING','REFUNDING')) OR
    (OLD.phase='ACTIVE' AND NEW.phase='SETTLING') OR
    (OLD.phase='SETTLING' AND NEW.phase='COMPLETED') OR
    (OLD.phase='REFUNDING' AND NEW.phase='CANCELLED')
  ) THEN RAISE EXCEPTION 'Invalid vault lifecycle transition'; END IF;
  IF OLD.phase<>'FUNDRAISING' AND NEW.accepted_capital_usdc IS DISTINCT FROM OLD.accepted_capital_usdc THEN
    RAISE EXCEPTION 'Activated principal is immutable';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND
     (NEW.finalized_at,NEW.final_supply,NEW.final_assets_usdc,NEW.distribution_pool_usdc,NEW.captain_fee_usdc,NEW.residue_liability_usdc,NEW.phase)
     IS DISTINCT FROM
     (OLD.finalized_at,OLD.final_supply,OLD.final_assets_usdc,OLD.distribution_pool_usdc,OLD.captain_fee_usdc,OLD.residue_liability_usdc,OLD.phase) THEN
    RAISE EXCEPTION 'Vault settlement is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER vault_terms_immutable BEFORE UPDATE ON vault_rounds FOR EACH ROW EXECUTE FUNCTION protect_vault_terms();
