import type { DbPool } from '@socially/db';
import type { Redis } from 'ioredis';
import { DiscoveryCache } from '@socially/market-data/discovery';
import { readHistory } from '@socially/market-data/history';
import { supportedTokens } from '@socially/market-data/catalog';
import { setTimeout as delay } from 'node:timers/promises';
import { JupiterClientError, type JupiterClient } from '@socially/market-data/client';

export async function refreshDiscovery(pool: DbPool, redis: Redis, client: JupiterClient, signal: AbortSignal) {
  const cache = new DiscoveryCache(pool, redis, client);
  for (const feed of ['toptraded', 'trending'] as const) for (const interval of ['5m','1h','6h','24h']) {
    signal.throwIfAborted();
    const defaultFeed = feed === 'toptraded' && interval === '24h' || feed === 'trending' && interval === '1h';
    if (defaultFeed || await redis.exists(`socially:discovery:demand:${feed}:${interval}`)) {
      await cache.get(`${feed}:${interval}`, async () => {
        // A metadata call or earlier feed may own the organisation's pacing slot.
        // Retry once after that bounded wait, acquiring a new scheduler permit.
        try { return await client.getCategory(feed, interval, signal); }
        catch (error) {
          if (!(error instanceof JupiterClientError) || error.code !== 'quota_wait' || error.retryAfterMs > 2000) throw error;
          await delay(error.retryAfterMs + 25, undefined, { signal });
          return client.getCategory(feed, interval, signal);
        }
      }).catch(() => undefined);
    }
  }
  for (const token of supportedTokens) for (const interval of ['7d','30d'] as const) {
    signal.throwIfAborted();
    const result = await readHistory(pool, token.mint, interval === '7d' ? '7D' : '30D');
    // Keep the same boundary and gap rules as charts; retain exact baseline/end times.
    const payload = { changePercent: result.changePercent, coverage: result.coverage, asOf: result.to };
    await pool.query(`INSERT INTO market_return_rollups(instrument_id,interval,payload,computed_at) VALUES($1,$2,$3,now())
      ON CONFLICT(instrument_id,interval) DO UPDATE SET payload=EXCLUDED.payload,computed_at=EXCLUDED.computed_at`, [token.id, interval, payload]);
  }
  await pool.query("DELETE FROM market_discovery_feeds WHERE cache_key LIKE 'search:%' AND fetched_at < now()-interval '15 minutes'");
}
