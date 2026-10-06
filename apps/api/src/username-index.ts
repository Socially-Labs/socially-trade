import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { inTransaction, type DbPool } from "@socially/db";
import type { FastifyBaseLogger } from "fastify";

export const legacyHandleSchema = { type: "string", pattern: "^[a-z0-9_]{3,24}$" } as const;
export const usernameSchema = { type: "string", pattern: "^[a-z][a-z0-9_]{2,23}$" } as const;
export const captainHandleSchema = legacyHandleSchema;
export interface IndexState { instance_id: string; revision: string }
const stateSql = "SELECT instance_id::text, revision::text FROM username_index_state WHERE singleton";
const ttl = 86_400;

// Check readiness and membership together: a missing filter is never treated as an empty one.
const checkScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] or redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
return redis.call('BF.EXISTS', KEYS[1], ARGV[2])`;
const addScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] or redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('BF.ADD', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 1`;
const publishScript = `
local current = redis.call('GET', KEYS[2])
if current and current > ARGV[1] then redis.call('DEL', KEYS[3]); return 0 end
redis.call('RENAME', KEYS[3], KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1`;
// Fixed-width strings avoid losing bigint precision inside Redis Lua.
const version = (revision: string) => revision.padStart(19, "0");
const keys = (state: IndexState) => {
  const prefix = `socially:{usernames:${state.instance_id}}`;
  return { filter: `${prefix}:bloom`, ready: `${prefix}:revision` };
};

/** Redis accelerates definite negatives only when its generation matches PostgreSQL. */
export class UsernameIndex {
  private readonly redis: Redis | undefined;
  private rebuilding: Promise<void> | undefined;
  private retryAt = 0;
  private closed = false;

  constructor(private readonly pool: DbPool, private readonly log: FastifyBaseLogger, url?: string) {
    if (url) {
      try {
        this.redis = new Redis(url, {
          connectTimeout: 1_000, commandTimeout: 1_000, maxRetriesPerRequest: 0,
          enableOfflineQueue: false, retryStrategy: () => 30_000,
        });
        // Connection errors must not emit unhandled events or reveal connection credentials.
        this.redis.on("error", () => {
          this.retryAt = Date.now() + 30_000;
        });
      } catch { this.log.warn("Invalid Redis configuration; Usernames use PostgreSQL"); }
    }
  }

  private usable(): Redis | undefined {
    return !this.closed && Date.now() >= this.retryAt && this.redis?.status === "ready" ? this.redis : undefined;
  }

  private degraded(): void {
    this.retryAt = Date.now() + 30_000;
    this.log.warn("Username Bloom index unavailable; using PostgreSQL");
  }

  private async exists(handle: string): Promise<boolean> {
    return !!(await this.pool.query("SELECT 1 FROM users WHERE username = $1", [handle])).rowCount;
  }

  async available(handle: string): Promise<boolean> {
    const redis = this.usable();
    if (!redis) return !await this.exists(handle);
    const state = (await this.pool.query<IndexState>(stateSql)).rows[0]!;
    const { filter, ready } = keys(state);
    try {
      const result = await redis.eval(checkScript, 2, filter, ready, version(state.revision), handle);
      if (result === 0) return true;
      if (result === -1) this.rebuild();
      // A positive can be a false positive, so always confirm it in the unique index.
    } catch { this.degraded(); }
    return !await this.exists(handle);
  }

  /** Called after commit with the exact revision read in the insertion transaction. */
  async added(handle: string, state: IndexState): Promise<void> {
    const redis = this.usable();
    if (!redis) return;
    const { filter, ready } = keys(state);
    try {
      const updated = await redis.eval(addScript, 2, filter, ready,
        version((BigInt(state.revision) - 1n).toString()), version(state.revision), handle, ttl);
      if (updated === 0) this.rebuild();
    } catch { this.degraded(); }
  }

  /** Coalesced per process; reads a consistent snapshot and atomically publishes a complete filter. */
  private rebuild(): void {
    if (this.rebuilding || !this.usable()) return;
    this.rebuilding = this.build().catch(() => this.degraded()).finally(() => { this.rebuilding = undefined; });
  }

  private async build(): Promise<void> {
    const redis = this.usable();
    if (!redis) return;
    await inTransaction(this.pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const state = (await client.query<IndexState>(stateSql)).rows[0]!;
      const { filter, ready } = keys(state);
      const temporary = `${filter}:build:${randomUUID()}`;
      const started = Date.now();
      try {
        await redis.eval("redis.call('BF.RESERVE', KEYS[1], '0.001', '100000'); redis.call('EXPIRE', KEYS[1], 120); return 1", 1, temporary);
        let after = "";
        while (true) {
          if (this.closed || Date.now() - started > 30_000) throw new Error("Bloom rebuild interrupted");
          const rows = (await client.query<{ handle: string }>(
            "SELECT username AS handle FROM users WHERE username > $1 ORDER BY username LIMIT 1000", [after],
          )).rows;
          if (!rows.length) break;
          await redis.call("BF.MADD", temporary, ...rows.map(row => row.handle));
          after = rows.at(-1)!.handle;
        }
        await redis.eval(publishScript, 3, filter, ready, temporary, version(state.revision), ttl);
      } finally {
        await redis.del(temporary).catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.rebuilding;
    this.redis?.disconnect();
  }
}
