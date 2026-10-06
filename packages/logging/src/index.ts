import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export const services = ["api", "worker", "ingestor"] as const;
export const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Service = typeof services[number];
export type Level = typeof levels[number];
export interface LogEntry {
  id: string; time: string; service: Service; level: Level; message: string;
  instance: string; requestId?: string; details: unknown;
}
export interface LogFilter { service?: Service; level?: Level; search?: string; requestId?: string; since?: number; limit?: number }
const MAX_ENTRIES = 2_000;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const sensitive = /authorization|cookie|password|passwd|secret|token|api.?key|jup.?acc|private.?key|mint.?authority|treasury|database.?url|redis.?url|^key$/i;
const publish = `redis.call('LPUSH', KEYS[1], unpack(ARGV)); redis.call('LTRIM', KEYS[1], 0, 1999); redis.call('EXPIRE', KEYS[1], 86400); return 1`;

/** Redact before aggregation; bounded traversal also handles Errors and circular console data. */
export function redact(value: unknown, secrets: string[] = [], seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) if (secret.length >= 8) result = result.split(secret).join("[REDACTED]");
    result = result.slice(0, 4_000);
    return result.replace(/\bBearer\s+[^\s,"']+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/((?:authorization|password|secret|token|api[_-]?key|access[_-]?key|jup_acc_\d+|\bkey)\s*[=:]\s*)[^\s&,;"']+/gi, "$1[REDACTED]")
      .slice(0, 4_000);
  }
  if (typeof value === "bigint") return String(value);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (value instanceof Error) return redact({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, secrets, seen, depth + 1);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date";
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, secrets, seen, depth + 1));
  try {
    return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, item]) => [key, sensitive.test(key) ? "[REDACTED]" : redact(item, secrets, seen, depth + 1)]));
  } catch { return "[UNSERIALIZABLE]"; }
}

export class LogCollector {
  private readonly redis: Redis | null;
  private readonly key: string;
  private readonly instance = `${hostname()}:${process.pid}`;
  private readonly secrets = Object.entries(process.env).filter(([key, value]) => sensitive.test(key) && value).map(([, value]) => value!);
  private readonly entries: LogEntry[] = [];
  private readonly pending: string[] = [];
  private flushing: Promise<void> | null = null;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly service: Service, options: { redisUrl?: string | null; key?: string } = {}) {
    const url = options.redisUrl === undefined ? process.env.REDIS_URL : options.redisUrl;
    this.key = options.key ?? process.env.LOG_REDIS_KEY ?? "socially:admin:logs:v1";
    this.redis = url ? new Redis(url, { connectTimeout: 1_000, commandTimeout: 2_000, enableOfflineQueue: false,
      maxRetriesPerRequest: 0, retryStrategy: () => 2_000 }) : null;
    this.redis?.on("error", () => undefined);
    this.timer = setInterval(() => void this.flush(), 250);
    this.timer.unref();
  }

  log(level: Level, message: string, details: unknown = {}, requestId?: string): void {
    if (this.closed) return;
    const entry: LogEntry = { id: randomUUID(), time: new Date().toISOString(), service: this.service, level,
      message: String(redact(message, this.secrets)), instance: this.instance,
      ...(requestId ? { requestId: String(redact(requestId, this.secrets)) } : {}), details: redact(details, this.secrets) };
    if (JSON.stringify(entry).length > 8_192) entry.details = { truncated: true, preview: JSON.stringify(entry.details).slice(0, 2_000) };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    if (this.redis) {
      this.pending.push(JSON.stringify(entry));
      if (this.pending.length > MAX_ENTRIES) this.pending.shift();
    }
  }

  /** Fastify/Pino destination: keep normal terminal output and capture structured records. */
  readonly stream = { write: (line: string) => {
    process.stdout.write(line);
    try {
      const { level, msg, time: _time, pid: _pid, hostname: _host, reqId, ...details } = JSON.parse(line);
      const name = levels[Math.max(0, Math.min(5, Math.floor(Number(level) / 10) - 1))] ?? "info";
      this.log(name, String(msg ?? ""), details, reqId);
    } catch { /* A malformed diagnostic must never break request handling. */ }
  } };

  async flush(batchSize = 100): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.redis || this.redis.status !== "ready" || this.pending.length === 0) return;
    const batch = this.pending.splice(0, batchSize);
    this.flushing = this.redis.eval(publish, 1, this.key, ...batch).then(() => undefined).catch(() => {
      // Preserve a bounded retry queue while terminal output and local logs stay available.
      this.pending.unshift(...batch);
      if (this.pending.length > MAX_ENTRIES) this.pending.splice(0, this.pending.length - MAX_ENTRIES);
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async read(filter: LogFilter = {}) {
    let shared: LogEntry[] = [];
    let transport: "redis" | "local" | "unavailable" = this.redis ? "unavailable" : "local";
    if (this.redis?.status === "ready") {
      try {
        const values = await this.redis.lrange(this.key, 0, MAX_ENTRIES - 1);
        shared = values.flatMap(value => {
          try { const entry = JSON.parse(value); return entry && services.includes(entry.service) && levels.includes(entry.level) && typeof entry.id === "string" && typeof entry.message === "string" && typeof entry.instance === "string" && Number.isFinite(Date.parse(entry.time)) ? [entry as LogEntry] : []; }
          catch { return []; }
        });
        transport = "redis";
      } catch { /* The UI explicitly reports unavailable aggregation. */ }
    }
    const cutoff = Date.now() - RETENTION_MS;
    // Local records start newest-first too, preserving order for equal millisecond timestamps.
    const byId = new Map([...this.entries.slice().reverse(), ...shared].filter(entry => Date.parse(entry.time) >= cutoff).map(entry => [entry.id, entry]));
    const retained = [...byId.values()].sort((a, b) => b.time.localeCompare(a.time)).slice(0, MAX_ENTRIES);
    const search = filter.search?.toLowerCase();
    const matches = retained.filter(entry => (!filter.service || entry.service === filter.service) && (!filter.level || entry.level === filter.level)
      && (!filter.since || Date.parse(entry.time) >= filter.since) && (!filter.requestId || entry.requestId === filter.requestId)
      && (!search || JSON.stringify(entry).toLowerCase().includes(search)));
    return { entries: matches.slice(0, Math.min(MAX_ENTRIES, filter.limit ?? 250)), total: matches.length, retained: retained.length,
      transport, retention: { maxEntries: MAX_ENTRIES, hours: 24 },
      services: services.map(service => ({ name: service, count: retained.filter(entry => entry.service === service).length,
        lastSeen: retained.find(entry => entry.service === service)?.time ?? null })),
      errors: retained.filter(entry => entry.level === "error" || entry.level === "fatal").length,
      warnings: retained.filter(entry => entry.level === "warn").length };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    // At most one command timeout during shutdown; no unbounded retry/drain loop.
    if (this.flushing) await this.flushing;
    await this.flush(MAX_ENTRIES);
    this.redis?.disconnect();
  }
}

/** Install only in executable entrypoints, never when importing application code in tests. */
export function captureConsole(collector: LogCollector): () => void {
  const mapping = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug", trace: "trace" } as const;
  const restore: Array<() => void> = [];
  for (const [method, level] of Object.entries(mapping)) {
    const name = method as keyof typeof mapping;
    const original = console[name];
    console[name] = (...args: unknown[]) => {
      original.apply(console, args);
      collector.log(level, args.map(arg => typeof arg === "string" ? arg : arg instanceof Error ? arg.message : "").filter(Boolean).join(" ") || "Console event", { arguments: args });
    };
    restore.push(() => { console[name] = original; });
  }
  const fatal = (error: Error) => { collector.log("fatal", error.message, error); void collector.flush(); };
  process.on("uncaughtExceptionMonitor", fatal);
  return () => { restore.forEach(fn => fn()); process.off("uncaughtExceptionMonitor", fatal); };
}
