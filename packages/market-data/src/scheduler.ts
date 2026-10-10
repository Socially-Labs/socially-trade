import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { JupiterAccount } from "./config.js";

// Every attempted HTTP request consumes a token. Retries never bypass this script.
const acquire = `
local clock = redis.call('TIME'); local now = clock[1]*1000 + math.floor(clock[2]/1000)
redis.call('SET', KEYS[7], '1', 'PX', 15000)
local disabled = redis.call('PTTL', KEYS[3])
if disabled > 0 then return disabled end
local permission = redis.call('PTTL', KEYS[5])
if permission > 0 then return permission end
local blocked = tonumber(redis.call('GET', KEYS[2]) or '0')
if blocked > now then return blocked-now end
local lease = redis.call('PTTL', KEYS[4])
if lease > 0 then return lease end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-60000)
local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if latest[2] and now-tonumber(latest[2]) < 1250 then return 1250-(now-tonumber(latest[2])) end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
 local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES'); return tonumber(oldest[2])+60000-now
end
-- Each class gets a small protected floor when it has recently requested service.
-- Idle reservations are borrowable; a waiting class cannot be permanently starved.
redis.call('SET', KEYS[7], '1', 'PX', 15000)
redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', now-60000)
local own = redis.call('ZCARD', KEYS[6])
local total = redis.call('ZCARD', KEYS[1])
if redis.call('EXISTS', KEYS[8]) == 1 and own >= tonumber(ARGV[3]) and total >= 48-tonumber(ARGV[4]) then
 return 1250
end
redis.call('ZADD', KEYS[6], now, ARGV[1]); redis.call('PEXPIRE', KEYS[6], 120000)
redis.call('SET', KEYS[4], ARGV[1], 'PX', 10000)
redis.call('ZADD', KEYS[1], now, ARGV[1]); redis.call('PEXPIRE', KEYS[1], 120000); return 0`;
const release = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
const block = `
local clock = redis.call('TIME'); local now = clock[1]*1000 + math.floor(clock[2]/1000)
local untilAt = math.max(now + tonumber(ARGV[1]), tonumber(ARGV[2]))
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if untilAt > current then redis.call('SET', KEYS[1], untilAt, 'PX', untilAt-now+1000) end
return math.max(untilAt, current)-now`;
const providerFailure = `
local clock = redis.call('TIME'); local now = clock[1]*1000 + math.floor(clock[2]/1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-20000)
redis.call('ZADD', KEYS[1], now, ARGV[1]); redis.call('PEXPIRE', KEYS[1], 20000)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
 redis.call('SET', KEYS[2], '1', 'PX', 10000, 'NX')
end
return math.max(0, redis.call('PTTL', KEYS[2]))`;

export interface JupiterPermit { account: JupiterAccount; token: string }
export type JupiterFailure = "rate_limit" | "credential" | "permission" | "transient";
export interface AccountScheduler {
  next(excluded: ReadonlySet<string>, signal: AbortSignal): Promise<JupiterPermit | { waitMs: number }>;
  failed(permit: JupiterPermit, failure: JupiterFailure, resetAt?: number | null): Promise<number>;
  succeeded(): Promise<void>;
  release(permit: JupiterPermit): Promise<void>;
}

export class JupiterScheduler implements AccountScheduler {
  private readonly provider: string;
  private readonly failureThreshold: number;
  constructor(private readonly redis: Redis, private readonly accounts: JupiterAccount[], private readonly product = "price-v3") {
    this.provider = `socially:{jupiter:provider}:${product}`;
    if (!accounts.length) throw new Error("At least one Jupiter account is required");
    this.failureThreshold = Math.min(3, new Set(accounts.map(account => account.organisation)).size);
  }
  private prefix(account: JupiterAccount) {
    return `socially:{jupiter:${createHash("sha256").update(account.organisation).digest("hex")}}`;
  }
  private names(account: JupiterAccount) {
    const prefix = this.prefix(account);
    return [`${prefix}:window`, `${prefix}:blocked`,
      `${prefix}:disabled:${createHash("sha256").update(account.key).digest("hex")}`, `${prefix}:lease`, `${prefix}:permission:${this.product}:${createHash("sha256").update(account.key).digest("hex")}`] as const;
  }
  async next(excluded: ReadonlySet<string> = new Set(), signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted();
    const providerWait = await this.redis.pttl(`${this.provider}:blocked`);
    if (providerWait > 0) return { waitMs: providerWait };
    const start = (Number(await this.redis.incr(`${this.provider}:rotation`)) - 1) % this.accounts.length;
    let waitMs = Infinity;
    for (let offset = 0; offset < this.accounts.length; offset++) {
      signal.throwIfAborted();
      const account = this.accounts[(start + offset) % this.accounts.length]!;
      if (excluded.has(account.id)) continue;
      const token = randomUUID();
      const prefix = this.prefix(account), tokens = this.product === 'tokens-v2';
      const own = tokens ? 'tokens' : 'prices', other = tokens ? 'prices' : 'tokens';
      const wait = Number(await this.redis.eval(acquire, 8, ...this.names(account),
        `${prefix}:class:${own}`,`${prefix}:demand:${own}`,`${prefix}:demand:${other}`,token,48,tokens?6:12,tokens?12:6));
      if (wait === 0) return { account, token };
      waitMs = Math.min(waitMs, wait);
    }
    return { waitMs: Number.isFinite(waitMs) ? Math.max(1, waitMs) : 1_000 };
  }
  async release(permit: JupiterPermit): Promise<void> {
    await this.redis.eval(release, 1, this.names(permit.account)[3], permit.token);
  }
  async succeeded(): Promise<void> {
    await this.redis.del(`${this.provider}:failures`);
  }
  async failed(permit: JupiterPermit, failure: JupiterFailure, resetAt?: number | null): Promise<number> {
    const names = this.names(permit.account);
    if (failure === "credential" || failure === "permission") {
      await this.redis.set(names[failure === "permission" ? 4 : 2], "1", "PX", 3_600_000);
      return 3_600_000;
    }
    const jitter = Math.floor(Math.random() * 500);
    // Rate-limit resets are absolute Unix milliseconds; leave a small reset margin.
    const wait = Number(await this.redis.eval(block, 1, names[1],
      failure === "rate_limit" ? (resetAt ? 1_000 : 5_000 + jitter) : 2_000 + jitter,
      failure === "rate_limit" && resetAt ? resetAt + 250 : 0));
    if (failure !== "transient") return wait;
    const providerWait = Number(await this.redis.eval(providerFailure, 2,
      `${this.provider}:failures`, `${this.provider}:blocked`, permit.account.organisation, this.failureThreshold));
    return Math.max(wait, providerWait);
  }
}
