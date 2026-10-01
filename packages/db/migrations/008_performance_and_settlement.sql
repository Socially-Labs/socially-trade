ALTER TABLE funds
  ADD COLUMN protocol_shares numeric(38,18) NOT NULL DEFAULT 0 CHECK (protocol_shares >= 0),
  ADD COLUMN performance_fee_factor numeric(38,18) NOT NULL DEFAULT 1 CHECK (performance_fee_factor >= 1),
  ADD COLUMN final_nav_usdc numeric(38,18),
  ADD COLUMN final_share_price_usdc numeric(38,18);

ALTER TABLE nav_snapshots
  ADD COLUMN performance_fee_factor numeric(38,18) NOT NULL DEFAULT 1 CHECK (performance_fee_factor >= 1);

ALTER TABLE fee_assessments
  ADD COLUMN model_version integer NOT NULL DEFAULT 1,
  ADD COLUMN pre_fee_share_price numeric(38,18),
  ADD COLUMN post_fee_share_price numeric(38,18),
  ADD COLUMN high_water_mark_before numeric(38,18),
  ADD COLUMN captain_shares numeric(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN protocol_shares numeric(38,18) NOT NULL DEFAULT 0;
