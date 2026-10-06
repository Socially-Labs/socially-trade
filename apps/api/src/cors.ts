import type { FastifyInstance } from "fastify";
import { ApiFault } from "./errors.js";

/** Explicit browser origins; native clients do not send an Origin header. */
export function registerCors(app: FastifyInstance): void {
  const origins = new Set((process.env.CORS_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  for (const origin of origins) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("CORS_ORIGINS must contain exact HTTP(S) origins");
  }
  app.addHook("onRequest", async (request, reply) => {
    reply.header("vary", "Origin");
    const origin = request.headers.origin;
    if (!origin) return;
    if (!origins.has(origin)) throw new ApiFault(403, "origin_forbidden", "Browser origin is not allowed");
    reply.header("access-control-allow-origin", origin);
    if (request.method === "OPTIONS") {
      const method = request.headers["access-control-request-method"];
      const headers = String(request.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      if (!method || !["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) ||
        headers.some(h => !["authorization", "content-type", "idempotency-key"].includes(h))) {
        throw new ApiFault(400, "invalid_preflight", "Unsupported browser request");
      }
      reply.header("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE");
      reply.header("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key");
      reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());
}
