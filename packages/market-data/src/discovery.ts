import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { JupiterClient, JupiterClientError } from './client.js';
import type { TokenMetadata } from './tokens.js';
export interface DiscoveryStorage {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export type DiscoverySnapshot = { id: string; fetchedAt: string; tokens: TokenMetadata[] };
export class DiscoveryUnavailable extends Error {
  constructor(readonly limited = false, readonly retryAfterMs = 1000) { super('Market feed is temporarily unavailable'); }
}
export const discoveryKey = (feed: string, interval: string) => `${feed}:${interval}`;
export const searchKey = (query: string) => `search:${createHash('sha256').update(query).digest('hex')}`;
export class DiscoveryCache {
  private shutdown = new AbortController();
  close() { this.shutdown.abort(); }
  private pending = new Map<string, Promise<DiscoverySnapshot>>();
  constructor(private pool: DiscoveryStorage, private redis: Redis, private client: JupiterClient) {}
  async stored(key: string): Promise<DiscoverySnapshot | null> {
    const row = (await this.pool.query('SELECT snapshot_id,fetched_at,payload FROM market_discovery_feeds WHERE cache_key=$1', [key])).rows[0];
    return row ? { id: String(row.snapshot_id), fetchedAt: (row.fetched_at as Date).toISOString(), tokens: row.payload as TokenMetadata[] } : null;
  }
  async get(key: string, fetcher: () => Promise<TokenMetadata[]>): Promise<DiscoverySnapshot> {
    // A newly constructed gateway connection needs a short, bounded startup window.
    for (let i=0; i<20 && ['connecting','connect'].includes(this.redis.status); i++) await new Promise(resolve => setTimeout(resolve,25));
    let hot: string | null = null;
    try { hot = await this.redis.get(`socially:discovery:hot:${key}`); } catch { /* Durable fallback works without Redis. */ }
    const previous = hot ? JSON.parse(hot) as DiscoverySnapshot : await this.stored(key);
    if (previous && Date.now() - Date.parse(previous.fetchedAt) <= 60_000) return previous;
    try { return await this.refresh(key, fetcher); }
    catch (error) {
      if (previous && Date.now() - Date.parse(previous.fetchedAt) <= 300_000) return previous;
      throw error;
    }
  }
  async refresh(key: string, fetcher: () => Promise<TokenMetadata[]>): Promise<DiscoverySnapshot> {
    const pending = this.pending.get(key); if (pending) return pending;
    if (this.pending.size >= 8) throw new DiscoveryUnavailable();
    const work = this.refreshShared(key, fetcher).finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
  private async refreshShared(key: string, fetcher: () => Promise<TokenMetadata[]>): Promise<DiscoverySnapshot> {
    const lock = `socially:discovery:lock:${key}`, owner = randomUUID();
    let owns = false;
    try {
      owns = !!await this.redis.set(lock, owner, 'PX', 12_000, 'NX');
      if (!owns) {
        // A gateway/ingestor owns the request. Wait briefly for its durable result.
        for (let i=0; i<20; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          const stored = await this.stored(key);
          if (stored && Date.now()-Date.parse(stored.fetchedAt)<60_000) return stored;
        }
        throw new DiscoveryUnavailable();
      }
      const recent = await this.stored(key);
      if (recent && Date.now()-Date.parse(recent.fetchedAt)<=60_000) return recent;
      const tokens = await fetcher();
      const snapshot = { id: randomUUID(), fetchedAt: new Date().toISOString(), tokens };
      // A single bounded upsert preserves all statistics windows. Failures never replace good snapshots.
      if (tokens.length) await this.pool.query(`INSERT INTO market_token_metadata(mint,payload,fetched_at)
        SELECT value->>'mint',value,$2::timestamptz FROM jsonb_array_elements($1::jsonb)
        ON CONFLICT(mint) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=EXCLUDED.fetched_at`, [JSON.stringify(tokens), snapshot.fetchedAt]);
      await this.pool.query(`INSERT INTO market_discovery_feeds(cache_key,snapshot_id,fetched_at,payload) VALUES($1,$2,$3,$4)
        ON CONFLICT(cache_key) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,fetched_at=EXCLUDED.fetched_at,payload=EXCLUDED.payload`,
        [key, snapshot.id, snapshot.fetchedAt, JSON.stringify(tokens)]);
      await this.redis.set(`socially:discovery:hot:${key}`,JSON.stringify(snapshot),'EX',300).catch(() => undefined);
      return snapshot;
    } catch (error) {
      if (error instanceof DiscoveryUnavailable) throw error;
      throw new DiscoveryUnavailable(error instanceof JupiterClientError && error.code === 'quota_wait', error instanceof JupiterClientError ? error.retryAfterMs : 1000);
    } finally {
      if (owns) await this.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,lock,owner).catch(() => undefined);
    }
  }
  search(query: string) { return this.get(searchKey(query), () => this.client.getTokens(query, this.shutdown.signal)); }
  category(feed: 'toptraded' | 'trending', interval: string) {
    return this.get(discoveryKey(feed, interval), () => this.client.getCategory(feed, interval, this.shutdown.signal));
  }
}
