import { fetchJupiterPrices, JupiterDataError, JupiterHttpError, type JupiterPrice } from "./jupiter.js";
import { fetchJupiterTokens, fetchJupiterCategory, type TokenMetadata } from "./tokens.js";
import { setTimeout as delay } from "node:timers/promises";
import type { AccountScheduler, JupiterFailure } from "./scheduler.js";

export class JupiterClientError extends Error {
  constructor(readonly code: "quota_wait" | "upstream_unavailable" | "scheduler_unavailable" | "invalid_response" | "deadline" | "cancelled" | "queue_full",
    readonly retryAfterMs = 1_000) { super(`Jupiter request failed: ${code}`); }
}
export interface JupiterClientEvent {
  accountId: string;
  attempt: number;
  failure: JupiterFailure;
  status?: number;
  cooldownMs: number;
}
interface ClientOptions {
  maxAttempts?: number;
  deadlineMs?: number;
  maxConcurrent?: number;
  fetchPrices?: typeof fetchJupiterPrices;
  fetchTokens?: typeof fetchJupiterTokens;
  fetchCategory?: typeof fetchJupiterCategory;
  onFailure?: (event: JupiterClientEvent) => void;
}

export class JupiterClient {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly attempts: number;
  private readonly deadline: number;
  private readonly concurrency: number;
  private readonly fetchPrices: typeof fetchJupiterPrices;
  constructor(private readonly scheduler: AccountScheduler, private readonly options: ClientOptions = {}) {
    this.attempts = options.maxAttempts ?? 3;
    this.deadline = options.deadlineMs ?? 8_000;
    this.concurrency = options.maxConcurrent ?? 2;
    this.fetchPrices = options.fetchPrices ?? fetchJupiterPrices;
    if (![this.attempts, this.deadline, this.concurrency].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Jupiter client limits must be positive integers");
    }
  }
  private async enter(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.concurrency) { this.active++; return; }
    if (this.queue.length >= 32) throw new JupiterClientError("queue_full");
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener("abort", aborted); resolve(); };
      const aborted = () => {
        const index = this.queue.indexOf(ready);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      this.queue.push(ready);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }
  private leave(): void {
    const next = this.queue.shift();
    if (next) next(); else this.active--;
  }
  async getPrices(mints: string[], callerSignal?: AbortSignal): Promise<Map<string, JupiterPrice>> {
    if (!mints.length || mints.length > 50) throw new JupiterDataError("Jupiter batches require 1-50 mints");
    return this.run((key, signal) => this.fetchPrices(key, mints, { signal }), callerSignal);
  }
  async getTokens(query: string, callerSignal?: AbortSignal): Promise<TokenMetadata[]> {
    if (!query.trim() || query.length > 4500) throw new JupiterDataError("Invalid token query");
    return this.run((key, signal) => (this.options.fetchTokens ?? fetchJupiterTokens)(key, query, { signal }), callerSignal, true);
  }
  async getCategory(feed: 'toptraded' | 'trending', interval: string, signal?: AbortSignal): Promise<TokenMetadata[]> {
    return this.run((key, signal) => (this.options.fetchCategory ?? fetchJupiterCategory)(key, feed, interval, { signal }), signal, true);
  }
  private async run<T>(fetchOperation: (key: string, signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal, tokenProduct = false): Promise<T> {
    const timeout = AbortSignal.timeout(this.deadline);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let entered = false;
    try {
      await this.enter(signal); entered = true;
      const excluded = new Set<string>();
      let retryAfterMs = Infinity;
      for (let attempt = 1; attempt <= this.attempts; attempt++) {
        signal.throwIfAborted();
        let permit;
        try {
          permit = await this.scheduler.next(excluded, signal);
          // Pacing another healthy request is normal, not a failed upstream attempt.
          // Wait only for short slots; long quota/cooldown waits remain caller-scheduled.
          while ("waitMs" in permit && permit.waitMs <= 1_500) {
            await delay(Math.max(1, permit.waitMs) + 25, undefined, { signal });
            permit = await this.scheduler.next(excluded, signal);
          }
        }
        catch { signal.throwIfAborted(); throw new JupiterClientError("scheduler_unavailable"); }
        if ("waitMs" in permit) {
          throw new JupiterClientError(excluded.size ? "upstream_unavailable" : "quota_wait",
            Math.min(retryAfterMs, permit.waitMs));
        }
        excluded.add(permit.account.id);
        try {
          signal.throwIfAborted();
          let prices;
          try { prices = await fetchOperation(permit.account.key, signal); }
          catch (error) {
            signal.throwIfAborted();
            if (error instanceof JupiterDataError) throw new JupiterClientError("invalid_response", 5_000);
            let failure: JupiterFailure;
            if (error instanceof JupiterHttpError) {
              if (error.status === 429) failure = "rate_limit";
              else if (error.status === 403 && tokenProduct) failure = "permission";
              else if (error.status === 401 || error.status === 403) failure = "credential";
              else if (error.status >= 500 || error.status === 408) failure = "transient";
              else throw new JupiterClientError("upstream_unavailable", 5_000);
            } else if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
              failure = "transient";
            } else throw new JupiterClientError("upstream_unavailable", 5_000);
            let cooldownMs;
            try { cooldownMs = await this.scheduler.failed(permit, failure, error instanceof JupiterHttpError ? error.resetAt : null); }
            catch { throw new JupiterClientError("scheduler_unavailable"); }
            retryAfterMs = Math.min(retryAfterMs, cooldownMs);
            this.options.onFailure?.({ accountId: permit.account.id, attempt, failure, cooldownMs,
              ...(error instanceof JupiterHttpError ? { status: error.status } : {}) });
            continue;
          }
          try { await this.scheduler.succeeded(); }
          catch { throw new JupiterClientError("scheduler_unavailable"); }
          return prices;
        } finally {
          // A lost Redis connection must stop fallback; the lease also expires after a crash.
          try { await this.scheduler.release(permit); }
          catch { throw new JupiterClientError("scheduler_unavailable"); }
        }
      }
      // Other accounts may still be healthy: retry the logical fetch soon, without a busy loop.
      throw new JupiterClientError("upstream_unavailable", Math.min(1_000, retryAfterMs));
    } catch (error) {
      if (signal.aborted) throw new JupiterClientError(callerSignal?.aborted ? "cancelled" : "deadline");
      throw error;
    } finally { if (entered) this.leave(); }
  }
}
