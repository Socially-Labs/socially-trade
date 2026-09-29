CREATE UNIQUE INDEX price_observations_source_ref_idx
ON price_observations(source, instrument_id, source_ref);
