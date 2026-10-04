import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { JupiterHttpError } from "@socially/market-data";

// Organisation-wide 60s window, 48/min safety budget, evenly paced at >=1s intervals.
const acquire = `
local clock = redis.call('TIME'); local now = clock[1]*1000 + math.floor(clock[2]/1000)
local blocked = tonumber(redis.call('GET', KEYS[2]) or '0')
if blocked > now then return blocked-now end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-60000)
local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if latest[2] and now-tonumber(latest[2]) < 1000 then return 1000-(now-tonumber(latest[2])) end
if redis.call('ZCARD', KEYS[1]) >= 48 then
 local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES'); return tonumber(oldest[2])+60000-now
end
redis.call('ZADD', KEYS[1], now, ARGV[1]); redis.call('PEXPIRE', KEYS[1], 120000); return 0`;
const block = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) end
return 1`;

export class JupiterScheduler {
  private readonly prefix: string;
  constructor(private readonly redis: Redis, private readonly keys: string[], organisation: string) {
    if (!keys.length) throw new Error("At least one Jupiter API key is required");
    this.prefix = `socially:{jupiter:${createHash('sha256').update(organisation).digest('hex')}}`;
  }
  private disabled(key: string) { return `${this.prefix}:disabled:${createHash('sha256').update(key).digest('hex')}`; }
  async next(): Promise<{ key: string } | { waitMs: number }> {
    let key: string | undefined;
    const start = Number(await this.redis.incr(`${this.prefix}:rotation`)) % this.keys.length;
    for (let offset = 0; offset < this.keys.length; offset++) {
      const candidate = this.keys[(start + offset) % this.keys.length]!;
      if (!await this.redis.exists(this.disabled(candidate))) { key = candidate; break; }
    }
    if (!key) return { waitMs: 30_000 };
    const waitMs = Number(await this.redis.eval(acquire, 2, `${this.prefix}:window`, `${this.prefix}:blocked`, randomUUID()));
    return waitMs > 0 ? { waitMs } : { key };
  }
  async failed(key: string, error: unknown): Promise<void> {
    if (error instanceof JupiterHttpError && (error.status === 401 || error.status === 403)) {
      await this.redis.set(this.disabled(key), "1", "EX", 3600);
    }
    const now = Date.now();
    const until = error instanceof JupiterHttpError && error.status === 429 && error.resetAt
      ? Math.max(now + 1_000, error.resetAt) : now + 5_000 + Math.floor(Math.random() * 1_000);
    await this.redis.eval(block, 1, `${this.prefix}:blocked`, until, Math.max(1_000, until - now + 1000));
  }
}
