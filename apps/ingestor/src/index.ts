import { createPool } from "@socially/db";
import { MarketBus } from "@socially/market-stream";
import { JupiterScheduler } from "./scheduler.js";
import { ingestJupiter, recordMarketPrice, unavailable } from "./ingest.js";

const keys = [...new Set((process.env.JUPITER_API_KEYS ?? "").split(",").map(key => key.trim()).filter(Boolean))];
const redisUrl = process.env.REDIS_URL;
const rpc = process.env.SOLANA_RPC_URL;
const organisation = process.env.JUPITER_ORGANISATION_ID;
if (!keys.length || !redisUrl || !rpc || !organisation) throw new Error("JUPITER_API_KEYS, REDIS_URL, SOLANA_RPC_URL and JUPITER_ORGANISATION_ID are required");
const pool = createPool(); const bus = new MarketBus(pool, redisUrl);
const scheduler = new JupiterScheduler(bus.redis, keys, organisation);
let running = true; let nextFetch = 0;
process.on("SIGINT", () => { running = false; }); process.on("SIGTERM", () => { running = false; });
const leader = await pool.connect();
let ownsSchedule = false;
leader.on("error", () => { running = false; });
try {
  while (running) {
    try {
      if (!ownsSchedule) ownsSchedule = (await leader.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(7810231) AS acquired")).rows[0]!.acquired;
      if (ownsSchedule && Date.now() >= nextFetch) {
        await leader.query("SELECT 1"); // verifies the session holding the scheduling lock is alive
        nextFetch = Date.now() + 5_000;
        const permit = await scheduler.next();
        if ("waitMs" in permit) nextFetch = Math.max(nextFetch, Date.now() + permit.waitMs);
        else {
          try { await ingestJupiter(pool, permit.key, rpc); }
          catch (error) {
            await scheduler.failed(permit.key, error);
            await recordMarketPrice(pool, unavailable("upstream_unavailable"));
            console.warn("Jupiter ingestion failed; shared backoff applied");
          }
        }
      }
      await bus.deliver();
    } catch { console.warn("Market ingestion/delivery unavailable; retrying without unbudgeted upstream requests"); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally {
  if (ownsSchedule) await leader.query("SELECT pg_advisory_unlock(7810231)").catch(() => undefined);
  leader.release(); bus.close(); await pool.end();
}
