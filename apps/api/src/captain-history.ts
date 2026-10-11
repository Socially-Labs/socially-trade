import type { DbPool } from '@socially/db';

/** Lifetime valuation evidence, independent of the selected chart range.
 * Count UTC days, not trades or account age; repeated marks never inflate a tier.
 * Only the returned directory page is queried, in one batch.
 */
export async function captainHistory(db: Pick<DbPool, 'query'>, ids: string[]) {
  const history = new Map(ids.map(id => [id, { recordedDays: 0 }]));
  if (!ids.length) return history;
  const rows = (await db.query(`SELECT captain_id,
    count(DISTINCT (recorded_at AT TIME ZONE 'UTC')::date)::integer AS days
    FROM captain_portfolio_observations
    WHERE captain_id=ANY($1::uuid[]) AND index_value IS NOT NULL AND NOT has_gap
      AND recorded_at<=transaction_timestamp()
    GROUP BY captain_id`, [ids])).rows;
  for (const row of rows) history.set(row.captain_id, { recordedDays: row.days });
  return history;
}
