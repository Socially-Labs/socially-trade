ALTER TABLE nav_snapshots
ADD COLUMN observation_id uuid REFERENCES price_observations(id);
