import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { idempotencyKey } from "./request.js";
import { ApiFault } from "./errors.js";
import type { TokenChain } from "./token-chain.js";
import { createQrDeposit, fundingSummary, readQrDeposit } from "./qr-deposits.js";

export function registerQrDepositRoutes(app: FastifyInstance, db: () => DbPool, chain: TokenChain | null) {
  app.get("/v0/me/wallet", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return fundingSummary(db(), chain, await requireActor(request, db()));
  });
  app.post<{ Body: { amount: string } }>("/v0/me/qr-deposits", {
    schema: { body: { type: "object", additionalProperties: false, required: ["amount"], properties: { amount: { type: "string", maxLength: 40 } } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    if (!chain) throw new ApiFault(503, "funding_unavailable", "Devnet funding is not configured");
    reply.header("cache-control", "no-store").code(201);
    return { deposit: await createQrDeposit(db(), chain, actor, idempotencyKey(request.headers["idempotency-key"]), request.body.amount) };
  });
  app.get<{ Params: { id: string } }>("/v0/me/qr-deposits/:id", {
    schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    reply.header("cache-control", "no-store");
    return { deposit: await readQrDeposit(db(), actor.id, request.params.id, chain) };
  });
}
