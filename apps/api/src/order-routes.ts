import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { getFund } from "./funds.js";
import { cancelOrder, getOrder, previewOrder, submitOrder } from "./orders.js";
import { idempotencyKey } from "./request.js";
import { historySchema, orderHistory, type HistoryQuery } from "./history.js";

export function registerOrderRoutes(app: FastifyInstance, db: () => DbPool): void {
  const orderBody = {
    type: "object", required: ["side", "instrumentId"], additionalProperties: false,
    properties: {
      side: { type: "string", enum: ["BUY", "SELL"] },
      instrumentId: { type: "string", minLength: 1, maxLength: 64 },
      notionalUsdc: { type: "string", maxLength: 40 },
      quantity: { type: "string", maxLength: 40 },
    },
    oneOf: [ { required: ["notionalUsdc"], not: { required: ["quantity"] } },
      { required: ["quantity"], not: { required: ["notionalUsdc"] }, properties: { side: { const: "SELL" } } } ],
  } as const;

  type PaperOrderBody = import("./orders.js").OrderInput;

  app.post<{ Params: { fundId: string }; Body: PaperOrderBody }>(
    "/v0/funds/:fundId/orders/preview", { schema: { body: orderBody } },
    async (request) => {
      const actor = await requireActor(request, db());
      await getFund(db(),request.params.fundId);
      return previewOrder(db(), actor, request.params.fundId, request.body);
    },
  );

  app.post<{ Params: { fundId: string }; Body: PaperOrderBody }>(
    "/v0/funds/:fundId/orders", { schema: { body: orderBody } },
    async (request, reply) => {
      const actor = await requireActor(request, db());
      await getFund(db(),request.params.fundId);
      const result = await submitOrder(db(), actor, request.params.fundId, request.body,
        idempotencyKey(request.headers["idempotency-key"]));
      reply.code(202);
      return result;
    },
  );

  app.get<{ Params: { fundId: string }; Querystring: HistoryQuery }>("/v0/funds/:fundId/orders", { schema: historySchema }, async (request) => {
    await getFund(db(), request.params.fundId);
    return { mode: "PAPER", ...await orderHistory(db(), "fund", request.params.fundId, request.query) };
  });

  app.get<{ Params: { fundId: string; orderId: string } }>(
    "/v0/funds/:fundId/orders/:orderId", async (request) => {
      return { mode: "PAPER", order: await getOrder(db(), request.params.fundId, request.params.orderId) };
    },
  );

  app.post<{ Params: { fundId: string; orderId: string } }>(
    "/v0/funds/:fundId/orders/:orderId/cancel", async (request) => {
      const actor = await requireActor(request, db());
      return cancelOrder(db(), actor, request.params.fundId, request.params.orderId);
    },
  );
}
