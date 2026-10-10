import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { levels, services, type LogCollector, type LogFilter } from "@socially/logging";
import { ApiFault } from "./errors.js";
import { logsHtml, logsCsp } from "./admin-logs-page.js";

export function authorize(request: FastifyRequest): void {
  const token = process.env.ADMIN_LOGS_TOKEN;
  if (token) {
    const supplied = request.headers.authorization?.replace(/^Bearer /i, "") ?? "";
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (timingSafeEqual(digest(supplied), digest(token))) return;
  } else if (process.env.NODE_ENV !== "production") {
    // Do not trust forwarding headers. Host validation prevents DNS rebinding into localhost.
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.raw.socket.remoteAddress ?? "");
    let hostname = "";
    try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch { /* rejected below */ }
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
    const origin = request.headers.origin;
    if (loopback && localHost && (!origin || origin === `${request.protocol}://${request.headers.host}`)) return;
  }
  throw new ApiFault(401, "admin_logs_unauthorized", "An admin log access token is required");
}

export function registerAdminLogs(app: FastifyInstance, logs: LogCollector): void {
  if (process.env.ADMIN_LOGS_ENABLED === "false") return;
  app.get("/admin/logs", { logLevel: "silent" }, async (_request, reply) => {
    return reply.header("cache-control", "no-store").header("content-security-policy", logsCsp)
      .header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff")
      .type("text/html; charset=utf-8").send(logsHtml);
  });
  app.get<{ Querystring: { service?: LogFilter["service"]; level?: LogFilter["level"]; q?: string; requestId?: string; since?: string; limit?: string } }>(
    "/admin/logs/data", {
      logLevel: "silent",
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
        authorize(request);
      },
      schema: { querystring: { type: "object", additionalProperties: false, properties: {
        service: { type: "string", enum: [...services] }, level: { type: "string", enum: [...levels] },
        q: { type: "string", maxLength: 200 }, requestId: { type: "string", maxLength: 200 },
        since: { type: "string", maxLength: 35 }, limit: { type: "string", pattern: "^[1-9][0-9]{0,3}$" },
      } } },
    }, async request => {
      const { service, level, q, requestId, since, limit } = request.query;
      const sinceMs = since === undefined ? undefined : Date.parse(since);
      if (sinceMs !== undefined && !Number.isFinite(sinceMs)) throw new ApiFault(400, "invalid_request", "since must be an ISO timestamp");
      if (limit && Number(limit) > 2_000) throw new ApiFault(400, "invalid_request", "limit must be between 1 and 2000");
      return logs.read({ service, level, search: q, requestId, since: sinceMs, limit: limit ? Number(limit) : 250 });
    },
  );
}
