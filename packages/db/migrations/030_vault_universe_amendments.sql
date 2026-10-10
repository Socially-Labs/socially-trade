-- Explicit asset-universe amendment evidence. Preserve the original accepted terms;
-- numeric economics, deadlines and closed rounds remain immutable.
CREATE TABLE vault_universe_amendments (
  fund_id uuid NOT NULL REFERENCES funds(id), policy_version integer NOT NULL,
  previous_terms jsonb NOT NULL, previous_hash text NOT NULL,
  amended_terms jsonb NOT NULL, amended_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(fund_id,policy_version),
  FOREIGN KEY(fund_id,policy_version) REFERENCES fund_policy_versions(fund_id,version)
);
CREATE OR REPLACE FUNCTION protect_vault_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.terms,NEW.terms_hash,NEW.terms_version,NEW.fee_model_version,
      NEW.funding_window_hours,NEW.duration_days,NEW.funding_started_at,NEW.funding_closes_at,NEW.trading_ends_at)
     IS DISTINCT FROM
     (OLD.terms,OLD.terms_hash,OLD.terms_version,OLD.fee_model_version,
      OLD.funding_window_hours,OLD.duration_days,OLD.funding_started_at,OLD.funding_closes_at,OLD.trading_ends_at) THEN
    IF NOT (
      OLD.phase IN ('FUNDRAISING','ACTIVE') AND NEW.phase=OLD.phase
      AND NEW.terms->>'universeMode'='DYNAMIC_SPOT'
      AND COALESCE(OLD.terms->>'universeMode','LEGACY_ALLOWLIST')='LEGACY_ALLOWLIST'
      AND (NEW.terms-'universeMode')=(OLD.terms-'universeMode')
      AND (NEW.terms_version,NEW.fee_model_version,NEW.funding_window_hours,NEW.duration_days,NEW.funding_started_at,NEW.funding_closes_at,NEW.trading_ends_at)
        IS NOT DISTINCT FROM
        (OLD.terms_version,OLD.fee_model_version,OLD.funding_window_hours,OLD.duration_days,OLD.funding_started_at,OLD.funding_closes_at,OLD.trading_ends_at)
      AND EXISTS (SELECT 1 FROM vault_universe_amendments a JOIN fund_policy_versions p ON p.fund_id=a.fund_id AND p.version=a.policy_version
        WHERE a.fund_id=OLD.fund_id AND a.previous_terms=OLD.terms AND a.previous_hash=OLD.terms_hash
          AND a.amended_terms=NEW.terms AND a.amended_hash=NEW.terms_hash AND p.universe_mode='DYNAMIC_SPOT')
    ) THEN RAISE EXCEPTION 'Vault financial terms are immutable'; END IF;
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
