ALTER TABLE nav_snapshots ADD COLUMN event_sequence bigint;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY fund_id ORDER BY created_at, id) AS sequence
  FROM nav_snapshots
)
UPDATE nav_snapshots n SET event_sequence = ranked.sequence
FROM ranked WHERE ranked.id = n.id AND n.event_sequence IS NULL;

CREATE UNIQUE INDEX nav_snapshots_fund_sequence_idx
ON nav_snapshots(fund_id, event_sequence);
