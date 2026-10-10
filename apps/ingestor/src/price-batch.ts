import type { DbPool } from '@socially/db';
import { JupiterClientError } from '@socially/market-data/client';

/** Scheduler deferrals preserve existing marks and do not count as provider failures. */
export async function refreshPriceBatch(pool: DbPool, ids: string[], fetchBatch: () => Promise<void>, unavailable: () => Promise<void>): Promise<number> {
  if (!ids.length) return 0;
  try {
    await fetchBatch();
    await pool.query("UPDATE market_tracking_state SET next_due_at=now()+interval '5 seconds',last_success_at=now(),failure_count=0,backoff_until=NULL WHERE instrument_id=ANY($1::text[])", [ids]);
    return 0;
  } catch (error) {
    if (error instanceof JupiterClientError && error.code === 'quota_wait') {
      const waitMs = Math.max(1, error.retryAfterMs);
      await pool.query("UPDATE market_tracking_state SET next_due_at=now()+$2::double precision * interval '1 millisecond' WHERE instrument_id=ANY($1::text[])", [ids, waitMs]);
      return waitMs;
    }
    await pool.query("UPDATE market_tracking_state SET failure_count=failure_count+1,backoff_until=now()+least(60,power(2,least(failure_count,5))) * interval '1 second' WHERE instrument_id=ANY($1::text[])", [ids]);
    await unavailable();
    throw error;
  }
}
