-- One identity/profile row for Crew and Captains. Existing handles remain unchanged.
ALTER TABLE users
  ADD COLUMN username text UNIQUE,
  ADD COLUMN role text CHECK (role IN ('crew', 'captain')),
  ADD COLUMN bio text NOT NULL DEFAULT '',
  ADD COLUMN avatar_url text,
  ADD COLUMN banner_url text;

UPDATE users u SET username=c.handle, role='captain', bio=c.bio,
  avatar_url=c.avatar_url, banner_url=c.banner_url
FROM captain_profiles c WHERE c.user_id=u.id;

ALTER TABLE users
  ADD CONSTRAINT users_signup_pair CHECK ((username IS NULL) = (role IS NULL)),
  -- Legacy Captain handles can start with a digit/underscore; new claims use stricter API validation.
  ADD CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_]{3,24}$'),
  ADD CONSTRAINT users_bio_length CHECK (length(bio) <= 500),
  ADD CONSTRAINT users_avatar_url_length CHECK (length(avatar_url) <= 2048),
  ADD CONSTRAINT users_banner_url_length CHECK (length(banner_url) <= 2048);

ALTER TABLE funds DROP CONSTRAINT funds_captain_id_fkey;
ALTER TABLE funds ADD CONSTRAINT funds_captain_id_fkey FOREIGN KEY (captain_id) REFERENCES users(id);
ALTER TABLE captain_asset_uploads DROP CONSTRAINT captain_asset_uploads_captain_id_fkey;
ALTER TABLE captain_asset_uploads RENAME TO user_asset_uploads;
ALTER TABLE user_asset_uploads RENAME COLUMN captain_id TO user_id;
ALTER TABLE user_asset_uploads ADD CONSTRAINT user_asset_uploads_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

DROP TABLE captain_profiles;
DROP FUNCTION advance_captain_handle_revision();
DROP TABLE captain_handle_index_state;

CREATE TABLE username_index_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO username_index_state(singleton) VALUES (true);
CREATE FUNCTION advance_username_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE username_index_state SET revision=revision+1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER username_inserted AFTER INSERT ON users
FOR EACH ROW WHEN (NEW.username IS NOT NULL) EXECUTE FUNCTION advance_username_revision();
CREATE TRIGGER username_deleted AFTER DELETE ON users
FOR EACH ROW WHEN (OLD.username IS NOT NULL) EXECUTE FUNCTION advance_username_revision();
CREATE TRIGGER username_changed AFTER UPDATE OF username ON users
FOR EACH ROW WHEN (OLD.username IS DISTINCT FROM NEW.username) EXECUTE FUNCTION advance_username_revision();
CREATE TRIGGER usernames_truncated AFTER TRUNCATE ON users
FOR EACH STATEMENT EXECUTE FUNCTION advance_username_revision();
