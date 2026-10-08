import { registerVaultUploadRoutes } from './vault-uploads.js';
import Fastify from "fastify";
import { registerVaultRateLimit } from "./vault-rate-limit.js";
import { registerVaultRoutes } from "./vault-routes.js";
import { registerVaultStream } from "./vault-stream.js";
import { LogCollector } from "@socially/logging";
import { registerAdminLogs } from "./admin-logs.js";
import { registerCors } from "./cors.js";
import websocket from "@fastify/websocket";
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
import type { TokenLayer } from "./token-flows.js";
import { registerTokenRoutes } from "./token-routes.js";

import { registerQrDepositRoutes } from "./qr-deposit-routes.js";

export interface AppOptions {
  logs?: LogCollector;
  /** Devnet token layer. Required exactly when USDG_MINT is set. */
  token?: TokenLayer | null;
}

export function createApp(pool: DbPool | null, options: AppOptions = {}) {
  const token = options.token ?? null;
  if (Boolean(process.env.USDG_MINT) !== Boolean(token) || (token && token.chain.mint !== process.env.USDG_MINT)) {
    throw new Error("The token layer must run with the configured USDG_MINT and no other mint");
  }
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

  app.addHook('onReady',async () => {
    if (token && pool && (await pool.query('SELECT 1 FROM vault_rounds LIMIT 1')).rowCount) {
      throw new Error('Paper vault rounds require an isolated paper environment; do not enable treasury token redemption on this database');
    }
  });
  registerCors(app);
  app.register(websocket, { options: { maxPayload: 8192 } });
  app.register(async scope => { registerMarketRoutes(scope, db); registerVaultStream(scope, db); });
  app.register(async scope => { registerVaultRateLimit(scope); registerVaultRoutes(scope, db); registerVaultUploadRoutes(scope, db); });

  app.get("/health", async () => ({ status: "ok", mode: "PAPER" }));
  registerAdminLogs(app, logs);

  registerAccountRoutes(app, db);
  registerSupportRoutes(app, db);
  registerAuthRoutes(app, db, token);
  registerAuthClientEvents(app);
  registerQrDepositRoutes(app, db, token?.chain ?? null);
  if (token) registerTokenRoutes(app, db, token.chain);
  registerFundRoutes(app, db);
  registerMarketCatalogRoutes(app, db);
  registerTradingContextRoutes(app, db);
  registerOrderRoutes(app, db);
  registerFundEventRoutes(app, db);
  registerSocialRoutes(app, db);
  registerNotificationRoutes(app, db);
  registerPerformanceRoutes(app, db);
  registerHistoryRoutes(app, db);

  app.addHook("onClose", async () => {
    await logs.close();
    await pool?.end();
  });
  return app;
}
