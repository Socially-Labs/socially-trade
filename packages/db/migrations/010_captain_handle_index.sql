-- Redis is advisory. This revision makes missing/stale filters detectable across API instances.
CREATE TABLE captain_handle_index_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO captain_handle_index_state (singleton) VALUES (true);

CREATE FUNCTION advance_captain_handle_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE captain_handle_index_state SET revision = revision + 1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER captain_handle_revision_changed
AFTER INSERT OR DELETE OR UPDATE OF handle OR TRUNCATE ON captain_profiles
FOR EACH STATEMENT EXECUTE FUNCTION advance_captain_handle_revision();
