ALTER TABLE captain_profiles
  ADD COLUMN avatar_url text,
  ADD COLUMN banner_url text,
  ADD CONSTRAINT captain_avatar_url_length CHECK (avatar_url IS NULL OR length(avatar_url) BETWEEN 1 AND 2048),
  ADD CONSTRAINT captain_banner_url_length CHECK (banner_url IS NULL OR length(banner_url) BETWEEN 1 AND 2048);
