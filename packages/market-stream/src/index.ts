import { Redis } from "ioredis";
import { freshPaperPrice } from "@socially/domain";
import { inTransaction, type DbPool } from "@socially/db";

export interface MarketPrice {
  instrumentId: string; mint: string; priceUsd: string | null; priceUsdc: string | null;
  source: "JUPITER_PRICE_V3"; sourceBlockId: string | null; sourceAt: string | null;
  quoteSourceBlockId: string | null; quoteSourceAt: string | null;
  receivedAt: string; observationId: string | null; status: "CURRENT" | "STALE" | "UNAVAILABLE";
  reason: string | null; change24h?: string | null;
}
export interface MarketEvent { type: "price_update" | "market_status"; eventId: string; price: MarketPrice }
export type StreamEntry = [string, string[]];
export const cursorPattern = /^(0|[1-9][0-9]{0,18})-0$/;
export function compareCursor(a: string, b: string): number {
  const left = BigInt(a.split("-")[0]!); const right = BigInt(b.split("-")[0]!);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function currentPrice(price: MarketPrice, now = Date.now()): MarketPrice {
  if (price.status === "UNAVAILABLE") return price;
  const source = price.sourceAt ? Date.parse(price.sourceAt) : NaN;
  const received = Date.parse(price.receivedAt);
  return freshPaperPrice(price.sourceAt, price.receivedAt, now)
    ? { ...price, status: "CURRENT", reason: null }
    : { ...price, status: "STALE", reason: "observation_stale" };
}
export function marketRedis(url: string): Redis {
  const redis = new Redis(url, { connectTimeout: 1_000, commandTimeout: 2_000,
    enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => 2_000 });
  redis.on("error", () => undefined); // callers surface availability without logging secret connection URLs
  return redis;
}

const publish = `
local last = redis.call('GET', KEYS[3])
local seq = ARGV[1]
if last and (#last > #seq or (#last == #seq and last >= seq)) then return 0 end
redis.call('XADD', KEYS[1], 'MAXLEN', '=', 10000, seq .. '-0', 'data', ARGV[3])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[4])
redis.call('SET', KEYS[3], seq)
return 1`;
const snapshot = `
local latest = redis.call('HGETALL', KEYS[2])
local first = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1)
return {redis.call('GET', KEYS[3]) or '0', latest, first[1] and first[1][1] or '0-0'}`;
const initialize = `
local last = redis.call('GET', KEYS[3])
if last and (last == '0' or (redis.call('EXISTS', KEYS[1]) == 1 and redis.call('EXISTS', KEYS[2]) == 1)) then return 0 end
redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[1], KEYS[2])
for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[2], ARGV[i], ARGV[i+1]) end
if ARGV[1] ~= '0' then redis.call('XADD', KEYS[1], ARGV[1] .. '-0', 'data', ARGV[2]) end
redis.call('SET', KEYS[3], ARGV[1]); return 1`;

export class MarketBus {
  readonly redis: Redis;
  private prefix: string | undefined;
  constructor(private readonly pool: DbPool, url: string) { this.redis = marketRedis(url); }
  private async ready(): Promise<void> {
    if (this.redis.status === "ready") return;
    if (this.redis.status === "end") throw new Error("Market stream closed");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.redis.off("ready", connected); this.redis.off("end", ended); };
      const connected = () => { cleanup(); resolve(); };
      const ended = () => { cleanup(); reject(new Error("Market stream unavailable")); };
      const timer = setTimeout(ended, 1_500);
      this.redis.once("ready", connected); this.redis.once("end", ended);
    });
  }
  private async names() {
    if (!this.prefix) {
      const state = await this.pool.query<{ instance_id: string }>("SELECT instance_id::text FROM market_feed_state WHERE singleton");
      this.prefix = `socially:{market:${state.rows[0]!.instance_id}}`;
    }
    return [`${this.prefix}:events`, `${this.prefix}:latest`, `${this.prefix}:sequence`] as const;
  }
  /** Recover snapshots after Redis loss; old cursors must resync at the new stream boundary. */
  async initialize(): Promise<void> {
    await this.ready();
    const names = await this.names();
    const [last, stream, latest] = await Promise.all([this.redis.get(names[2]), this.redis.exists(names[0]), this.redis.exists(names[1])]);
    if (last === "0" || (last && stream && latest)) return;
    await inTransaction(this.pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = (await client.query<{ sequence: string }>("SELECT sequence::text FROM market_feed_state WHERE singleton")).rows[0]!;
      const rows = (await client.query<{ instrument_id: string; payload: MarketEvent }>("SELECT instrument_id,payload FROM market_latest")).rows;
      await this.redis.eval(initialize, 3, ...names, state.sequence, JSON.stringify({ type: "resync_required" }),
        ...rows.flatMap(row => [row.instrument_id, JSON.stringify(row.payload.price)]));
    });
  }
  async snapshot() {
    await this.initialize();
    const value = await this.redis.eval(snapshot, 3, ...await this.names()) as [string, string[], string];
    const prices: MarketPrice[] = [];
    for (let i = 1; i < value[1].length; i += 2) prices.push(currentPrice(JSON.parse(value[1][i]!)));
    return { cursor: `${value[0]}-0`, firstCursor: value[2], prices };
  }
  async read(after: string): Promise<StreamEntry[]> {
    const [stream] = await this.names();
    return await this.redis.xrange(stream, `(${after}`, "+", "COUNT", 100);
  }
  /** Serial publisher preserves commit order; replay after a crash is idempotent in Redis. */
  async deliver(): Promise<number> {
    await this.initialize();
    return inTransaction(this.pool, async client => {
      const lock = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(7810232) AS acquired")).rows[0]!;
      if (!lock.acquired) return 0;
      const rows = (await client.query<{ sequence: string; instrument_id: string; payload: MarketEvent }>(
        "SELECT sequence::text,instrument_id,payload FROM market_events WHERE delivered_at IS NULL ORDER BY sequence LIMIT 100 FOR UPDATE",
      )).rows;
      for (const row of rows) {
        await this.redis.eval(publish, 3, ...await this.names(), row.sequence, row.instrument_id,
          JSON.stringify(row.payload), JSON.stringify(row.payload.price));
        await client.query("UPDATE market_events SET delivered_at=now() WHERE sequence=$1", [row.sequence]);
      }
      return rows.length;
    });
  }
  close(): void { this.redis.disconnect(); }
}
