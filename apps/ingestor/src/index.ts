import { BirdeyeHistoryProvider, historyProviderEnabled, historyPermit, processHistoryJob } from "@socially/market-data/backfill";
import { registeredInstruments } from "@socially/market-data/registry";
import { createPool,serviceHeartbeat } from "@socially/db";
import { captureConsole, LogCollector } from "@socially/logging";
import { MarketBus } from "@socially/market-stream";
import { JupiterScheduler } from "./scheduler.js";
import { JupiterClient, JupiterClientError } from "./client.js";
import { loadJupiterAccounts } from "./config.js";
import { refreshDiscovery } from "./discovery.js";
import { refreshMarketMetadata } from "./metadata.js";
import { ingestJupiter, unavailableMarkets } from "./ingest.js";
import { refreshPriceBatch } from './price-batch.js';

const logs = new LogCollector("ingestor");
captureConsole(logs);
console.info("Market ingestor starting");
const accounts = loadJupiterAccounts();
const redisUrl = process.env.REDIS_URL;
// Jupiter prices carry mainnet slots; wallet SOLANA_RPC_URL may point to devnet.
const rpc = process.env.MARKET_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
if (!redisUrl) throw new Error("REDIS_URL is required");
const pool = createPool(); const heartbeat=serviceHeartbeat(pool,'ingestor'); const bus = new MarketBus(pool, redisUrl);
const scheduler = new JupiterScheduler(bus.redis, accounts);
const jupiter = new JupiterClient(scheduler, {
  onFailure: event => console.warn("Jupiter account cooling down", event),
});
console.info("Jupiter ingestor configured", { accounts: accounts.length, requestsPerMinutePerOrganisation: 48 });
const metadataClient = new JupiterClient(new JupiterScheduler(bus.redis, accounts, "tokens-v2"));
let historyJob:Promise<unknown>|undefined;let nextHistory=0;
let discoveryJob: Promise<void> | undefined; let nextDiscovery = 0;
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
        nextFetch = Date.now() + 1_250;
        try {
          const watched = await bus.redis.zrangebyscore('socially:market:watched','('+Date.now(),'+inf','LIMIT',0,200);
          await pool.query(`INSERT INTO market_tracking_state(instrument_id,priority)
            SELECT id, min(priority) FROM (
              SELECT instrument_id AS id,0 AS priority FROM orders WHERE status='PENDING'
              UNION ALL SELECT p.instrument_id,1 FROM positions p JOIN funds f ON f.id=p.fund_id WHERE p.quantity>0 AND f.status<>'COMPLETED'
              UNION ALL SELECT id,2 FROM instruments WHERE id=ANY($1::text[]) OR id IN ('SOL','JUP','JTO','BONK','USDC')
            ) demand GROUP BY id ON CONFLICT(instrument_id) DO UPDATE SET priority=EXCLUDED.priority`,[watched]);
          const due = (await pool.query<{instrument_id:string}>(`SELECT s.instrument_id FROM market_tracking_state s
            WHERE next_due_at<=now() AND (backoff_until IS NULL OR backoff_until<=now()) AND (
              s.instrument_id=ANY($1::text[]) OR s.instrument_id IN ('SOL','JUP','JTO','BONK','USDC')
              OR EXISTS(SELECT 1 FROM positions p JOIN funds f ON f.id=p.fund_id WHERE p.instrument_id=s.instrument_id AND p.quantity>0 AND f.status<>'COMPLETED')
              OR EXISTS(SELECT 1 FROM orders o WHERE o.instrument_id=s.instrument_id AND o.status='PENDING'))
            ORDER BY priority,next_due_at LIMIT 49`,[watched])).rows.map(row=>row.instrument_id);
          const tokens = await registeredInstruments(pool,due);
          const deferredMs = await refreshPriceBatch(pool, tokens.map(token => token.id),
            () => ingestJupiter(pool,jupiter,rpc,shutdown.signal,tokens),
            () => unavailableMarkets(pool,'batch_unavailable',tokens));
          if (deferredMs) nextFetch = Math.max(nextFetch, Date.now() + deferredMs);
        }
        catch (error) {
          if (!running) break;
          if (error instanceof JupiterClientError) nextFetch = Math.max(nextFetch, Date.now() + error.retryAfterMs);

          console.warn("Market ingestion unavailable", { reason: error instanceof JupiterClientError ? error.code : "rpc_or_storage_failure" });
        }
      }
      if (ownsSchedule && !metadataJob && Date.now() >= nextMetadata) {
        nextMetadata = Date.now() + 3_600_000;
        metadataJob = refreshMarketMetadata(pool, metadataClient, shutdown.signal)
          .catch(() => { console.warn("Market metadata unavailable; keeping last known catalog"); })
          .finally(() => { metadataJob = undefined; });
      }
      if (process.env.MARKET_DISCOVERY_V1_ENABLED === 'true' && ownsSchedule && !discoveryJob && Date.now() >= nextDiscovery) {
        nextDiscovery = Date.now() + 60_000 + Math.floor(Math.random() * 5000);
        discoveryJob = refreshDiscovery(pool, bus.redis, metadataClient, shutdown.signal)
          .catch(() => console.warn('Discovery refresh unavailable; retaining snapshots'))
          .finally(() => { discoveryJob = undefined; });
      }
      if(ownsSchedule && historyProviderEnabled() && !historyJob && Date.now()>=nextHistory){
        nextHistory=Date.now()+1100;
        historyJob=processHistoryJob(pool,new BirdeyeHistoryProvider(process.env.BIRDEYE_API_KEY!),()=>historyPermit(bus.redis)).catch(()=>console.warn('History job unavailable')).finally(()=>{historyJob=undefined;});
      }
      await bus.deliver();
      if(ownsSchedule)await heartbeat();
    } catch { console.warn("Market ingestion/delivery unavailable; retrying without unbudgeted upstream requests"); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally {
  console.info("Market ingestor stopping");
  await Promise.allSettled([metadataJob, discoveryJob, historyJob]);
  await logs.close();
  if (ownsSchedule) await leader.query("SELECT pg_advisory_unlock(7810231)").catch(() => undefined);
  leader.release(); bus.close(); await pool.end();
}
