CREATE TABLE captain_asset_uploads (
  id uuid PRIMARY KEY,
  captain_id uuid NOT NULL REFERENCES captain_profiles(user_id),
  kind text NOT NULL CHECK (kind IN ('avatar', 'banner')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  staging_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED')),
  public_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  completed_at timestamptz,
  CHECK ((status='PENDING' AND public_url IS NULL AND completed_at IS NULL)
      OR (status='COMPLETED' AND public_url IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX captain_upload_rate ON captain_asset_uploads(captain_id,created_at DESC);
CREATE INDEX captain_assets_owned_url ON captain_asset_uploads(captain_id,kind,public_url) WHERE status='COMPLETED';
