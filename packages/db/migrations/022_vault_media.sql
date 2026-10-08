-- Artwork belongs to the round, never to the Captain's profile.
CREATE TABLE vault_asset_uploads (
 id uuid PRIMARY KEY, fund_id uuid NOT NULL REFERENCES vault_rounds(fund_id),
 user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('avatar','banner')),
 content_type text NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880), staging_key text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED')),
 lease_id uuid, lease_until timestamptz, public_url text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes', completed_at timestamptz
);
CREATE INDEX vault_upload_user_budget ON vault_asset_uploads(user_id,created_at DESC);
CREATE TABLE vault_media (
 fund_id uuid NOT NULL REFERENCES vault_rounds(fund_id), kind text NOT NULL CHECK(kind IN ('avatar','banner')),
 upload_id uuid NOT NULL UNIQUE REFERENCES vault_asset_uploads(id), public_url text NOT NULL,
 PRIMARY KEY(fund_id,kind)
);
