import { registerWalletNotifications, startWalletNotificationScanner } from './wallet-notifications.js';
import { registerNotificationDevices } from './notification-devices.js';
import { registerCrewDiscovery } from './crew-discovery.js';
import { registerReadiness } from './readiness.js';
import { registerPaperActivity } from './paper-activity.js';
import { registerPaperTradingHealth } from './paper-trading-health.js';
import { registerMarketTrackingRoutes } from "./market-tracking.js";
import { registerTokenIconRoutes } from './token-icons.js';
import { registerPaperPortfolioRoutes,DevnetPaperSnapshotSource,type PaperSnapshotSource } from './paper-portfolio.js';
import { registerCaptainDashboardRoutes } from './captain-dashboard.js';
import { registerLiveVaultRoutes, startLiveVaultWorker } from './live-vault-routes.js';
import type { LiveChain } from './live-vault-chain.js';
import { registerVaultUploadRoutes } from './vault-uploads.js';
import Fastify from "fastify";
import { registerVaultRateLimit } from "./vault-rate-limit.js";
import { registerVaultRoutes } from "./vault-routes.js";
import { registerVaultStream } from "./vault-stream.js";
import { LogCollector } from "@socially/logging";
import { registerAdminLogs } from "./admin-logs.js";
import { registerCors } from "./cors.js";
import websocket from "@fastify/websocket";
import { registerMarketDiscoveryRoutes } from "./market-discovery-routes.js";
import { registerMarketCatalogRoutes } from "./market-catalog-routes.js";
import { registerTradingContextRoutes } from "./trading-context.js";
import { registerMarketRoutes } from "./market-routes.js";
import type { DbPool } from "@socially/db";
import { ApiFault } from "./errors.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerSupportRoutes } from "./support-routes.js";
import { registerFundRoutes } from "./fund-routes.js";
import { registerOrderRoutes } from "./order-routes.js";
import { registerFundEventRoutes } from "./events.js";
import { registerSocialRoutes } from "./social.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerPerformanceRoutes } from "./performance.js";
import { registerHistoryRoutes } from "./history.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerAuthClientEvents } from "./auth-client-events.js";

import { registerSwapRoutes } from "./swap-routes.js";
import { startSwapWorker, type SwapLayer } from "./swap-flows.js";
import { registerWalletRoutes } from "./wallet-routes.js";

export interface AppOptions {
  paperSnapshotSource?: PaperSnapshotSource;
  liveVaults?: LiveChain | null;
  liveVaultWorker?: boolean;
  logs?: LogCollector;
  swaps?: SwapLayer | null;
  /** Tests can drive reconciliation explicitly. */
  swapWorker?: boolean;
}

export function createApp(pool: DbPool | null, options: AppOptions = {}) {
  const logs = options.logs ?? new LogCollector("api");
  const app = Fastify({
    logger: { level: "info", stream: logs.stream },
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const db = (): DbPool => {
    if (!pool) throw new ApiFault(503, "database_unconfigured", "DATABASE_URL is required");
    return pool;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiFault) {
      reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if(typeof error==='object'&&error!==null&&'code' in error&&(error.code==='55P03'||error.code==='57014')){
      reply.header('retry-after','1').code(503).send({error:error.code==='55P03'?'lock_timeout':'query_timeout',message:'The operation is busy. Retry shortly.'});return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      reply.code(409).send({ error: "conflict", message: "Resource already exists" });
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "22P02") {
      reply.code(400).send({ error: "invalid_identifier", message: "Invalid identifier" });
      return;
    }
    if (typeof error === "object" && error !== null && "validation" in error) {
      reply.code(400).send({ error: "invalid_request", message: String(error) });
      return;
    }
    if (typeof error === "object" && error !== null && "statusCode" in error &&
        typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      reply.code(error.statusCode).send({ error: "invalid_request", message: String(error) });
      return;
    }
    app.log.error(error);
    reply.code(500).send({ error: "internal_error", message: "Internal server error" });
  });

  registerCors(app);
  app.register(websocket, {
    options: { maxPayload: 8192 },
    // A phone suspended during a watch restart may never acknowledge a close
    // handshake. Terminate upgraded sockets before HTTP draining/onClose hooks.
    preClose(done) {
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    },
  });
  app.register(async scope => { registerMarketRoutes(scope, db); registerVaultStream(scope, db); });
  app.register(async scope => { registerVaultRateLimit(scope); registerCaptainDashboardRoutes(scope, db); registerPaperPortfolioRoutes(scope,db,options.paperSnapshotSource??new DevnetPaperSnapshotSource(process.env.SOLANA_RPC_URL??process.env.DEVNET_RPC_URL??'https://api.devnet.solana.com')); registerVaultRoutes(scope, db); registerCrewDiscovery(scope, db); registerVaultUploadRoutes(scope, db); });
  app.register(async scope => { registerVaultRateLimit(scope); registerLiveVaultRoutes(scope, db, options.liveVaults ?? null); });
  let stopLiveVaultWorker: (() => Promise<void>) | undefined;
  app.addHook('onReady', async () => { if (pool && options.liveVaults && options.liveVaultWorker !== false) stopLiveVaultWorker = startLiveVaultWorker(pool,options.liveVaults,error=>app.log.error(error)); });
  app.addHook('preClose', async () => { await stopLiveVaultWorker?.(); });

  registerReadiness(app,db);
  registerAdminLogs(app, logs);

  registerAccountRoutes(app, db);
  registerSupportRoutes(app, db);
  registerAuthRoutes(app, db);
  registerAuthClientEvents(app);
  registerWalletRoutes(app, db);
  registerWalletNotifications(app, db);
  let stopWalletNotifications: (()=>Promise<void>) | undefined;
  app.addHook('onReady',async()=>{if(pool && process.env.WALLET_NOTIFICATIONS_ENABLED==='true'){stopWalletNotifications=startWalletNotificationScanner(pool,error=>app.log.error(error));app.log.info({walletNotificationsEnabled:true,network:'devnet'},'Wallet notification observer started');}});
  app.addHook('preClose',async()=>{await stopWalletNotifications?.();});
  registerSwapRoutes(app, db, options.swaps ?? null);
  let stopSwapWorker: (() => Promise<void>) | undefined;
  app.addHook("onReady", async () => {
    if (pool && options.swaps && options.swapWorker !== false) stopSwapWorker = startSwapWorker(pool, options.swaps.chain, error => app.log.error(error));
  });
  app.addHook("preClose", async () => { await stopSwapWorker?.(); });
  registerFundRoutes(app, db);
  registerMarketCatalogRoutes(app, db);
  registerMarketDiscoveryRoutes(app, db);
  registerTokenIconRoutes(app, db);
  registerMarketTrackingRoutes(app, db);
  registerTradingContextRoutes(app, db);
  registerOrderRoutes(app, db);
  registerPaperTradingHealth(app, db);
  registerFundEventRoutes(app, db);
  registerSocialRoutes(app, db);
  registerNotificationRoutes(app, db);
  registerNotificationDevices(app, db);
  registerPerformanceRoutes(app, db);
  registerHistoryRoutes(app, db);
  registerPaperActivity(app, db);

  app.addHook("onClose", async () => {
    await logs.close();
    await pool?.end();
  });
  return app;
}
