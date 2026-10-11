-- Explicit ownership and provenance for optional development fixtures.
CREATE TABLE discovery_demo_seeds (
  captain_id uuid PRIMARY KEY REFERENCES users(id),
  fund_id uuid NOT NULL UNIQUE REFERENCES funds(id),
  media_key text NOT NULL CHECK(media_key IN ('silver-tide','coral-compass','stormwake','golden-horizon','quiet-harbor')),
  reference jsonb NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE discovery_demo_seeds IS 'Opt-in local demo data; original identities and synthetic NAV. Never investment recommendations or imported trading accounts.';
