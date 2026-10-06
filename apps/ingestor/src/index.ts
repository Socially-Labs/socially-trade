import { createPool } from "@socially/db";
import { captureConsole, LogCollector } from "@socially/logging";
import { MarketBus } from "@socially/market-stream";
import { JupiterScheduler } from "./scheduler.js";
import { JupiterClient, JupiterClientError } from "./client.js";
import { loadJupiterAccounts } from "./config.js";
import { refreshMarketMetadata } from "./metadata.js";
import { ingestJupiter, unavailableMarkets } from "./ingest.js";

const logs = new LogCollector("ingestor");
captureConsole(logs);
console.info("Market ingestor starting");
const accounts = loadJupiterAccounts();
const redisUrl = process.env.REDIS_URL;
const rpc = process.env.MARKET_RPC_URL ?? process.env.SOLANA_RPC_URL;
if (!redisUrl || !rpc) throw new Error("REDIS_URL and MARKET_RPC_URL (or SOLANA_RPC_URL) are required");
const pool = createPool(); const bus = new MarketBus(pool, redisUrl);
const scheduler = new JupiterScheduler(bus.redis, accounts);
const jupiter = new JupiterClient(scheduler, {
  onFailure: event => console.warn("Jupiter account cooling down", event),
});
console.info("Jupiter ingestor configured", { accounts: accounts.length, requestsPerMinutePerOrganisation: 48 });
const metadataClient = new JupiterClient(new JupiterScheduler(bus.redis, accounts, "tokens-v2"));
let metadataJob: Promise<void> | undefined; let nextMetadata = 0;
const shutdown = new AbortController();
let running = true; let nextFetch = 0;
const stop = () => { running = false; shutdown.abort(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const leader = await pool.connect();
let ownsSchedule = false;
leader.on("error", stop);
try {
  while (running) {
    try {
      if (!ownsSchedule) ownsSchedule = (await leader.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(7810231) AS acquired")).rows[0]!.acquired;
      if (ownsSchedule && Date.now() >= nextFetch) {
        await leader.query("SELECT 1"); // verifies the session holding the scheduling lock is alive
        nextFetch = Date.now() + 5_000;
        try { await ingestJupiter(pool, jupiter, rpc, shutdown.signal); }
        catch (error) {
          if (!running) break;
          if (error instanceof JupiterClientError) nextFetch = Math.max(nextFetch, Date.now() + error.retryAfterMs);
          await unavailableMarkets(pool, error instanceof JupiterClientError ? error.code : "ingestion_unavailable");
          console.warn("Market ingestion unavailable", { reason: error instanceof JupiterClientError ? error.code : "rpc_or_storage_failure" });
        }
      }
      if (ownsSchedule && !metadataJob && Date.now() >= nextMetadata) {
        nextMetadata = Date.now() + 60_000;
        metadataJob = refreshMarketMetadata(pool, metadataClient, shutdown.signal)
          .catch(() => { console.warn("Market metadata unavailable; keeping last known catalog"); })
          .finally(() => { metadataJob = undefined; });
      }
      await bus.deliver();
    } catch { console.warn("Market ingestion/delivery unavailable; retrying without unbudgeted upstream requests"); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally {
  console.info("Market ingestor stopping");
  await metadataJob;
  await logs.close();
  if (ownsSchedule) await leader.query("SELECT pg_advisory_unlock(7810231)").catch(() => undefined);
  leader.release(); bus.close(); await pool.end();
}
