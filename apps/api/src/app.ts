import Fastify from "fastify";
import type { DbPool } from "@socially/db";
import { ApiFault } from "./errors.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerFundRoutes } from "./fund-routes.js";
import { registerOrderRoutes } from "./order-routes.js";
import { registerFundEventRoutes } from "./events.js";
import { registerSocialRoutes } from "./social.js";
import { registerNotificationRoutes } from "./notifications.js";

export function createApp(pool: DbPool | null) {
  const app = Fastify({
    logger: true,
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

  app.get("/health", async () => ({ status: "ok", mode: "PAPER" }));

  registerAccountRoutes(app, db);
  registerFundRoutes(app, db);
  registerOrderRoutes(app, db);
  registerFundEventRoutes(app, db);
  registerSocialRoutes(app, db);
  registerNotificationRoutes(app, db);

  app.addHook("onClose", async () => {
    await pool?.end();
  });
  return app;
}
