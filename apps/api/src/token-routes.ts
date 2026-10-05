import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { idempotencyKey } from "./request.js";
import type { TokenChain } from "./token-chain.js";
import {
  claimDeposit, prepareDeposit, requestWithdrawal, tokenBalances, verifyDeposit, withdrawalStatus, type DepositView,
} from "./token-flows.js";

// Base58 transaction signature (64 bytes).
const signatureSchema = { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{64,88}$" } as const;
const amountSchema = { type: "string", maxLength: 40 } as const;
const uuidSchema = { type: "string", format: "uuid" } as const;
const depositCode = (deposit: DepositView) => deposit.status === "PENDING" ? 202 : 200;

export function registerTokenRoutes(app: FastifyInstance, db: () => DbPool, chain: TokenChain): void {
  app.get("/v0/me/token-balance", async (request, reply) => {
    const actor = await requireActor(request, db());
    reply.header("cache-control", "no-store");
    return tokenBalances(db(), chain, actor);
  });

  app.post<{ Body: { amountUsdc: string } }>("/v0/me/deposits/prepare", {
    schema: { body: { type: "object", required: ["amountUsdc"], additionalProperties: false,
      properties: { amountUsdc: amountSchema } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    reply.header("cache-control", "no-store");
    return prepareDeposit(db(), chain, actor, request.body.amountUsdc);
  });

  app.post<{ Body: { signature: string; amountUsdc: string; fundId?: string } }>("/v0/me/deposits", {
    schema: { body: { type: "object", required: ["signature", "amountUsdc"], additionalProperties: false,
      properties: { signature: signatureSchema, amountUsdc: amountSchema, fundId: uuidSchema } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const deposit = await claimDeposit(db(), chain, actor, request.body);
    reply.code(depositCode(deposit));
    return { mode: "PAPER", deposit };
  });

  app.get<{ Params: { signature: string } }>("/v0/me/deposits/:signature", {
    schema: { params: { type: "object", required: ["signature"], properties: { signature: signatureSchema } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const deposit = await verifyDeposit(db(), chain, actor, request.params.signature, null);
    reply.code(depositCode(deposit));
    return { mode: "PAPER", deposit };
  });

  app.post<{ Body: { amountUsdc?: string; fundId?: string; shares?: string } }>("/v0/me/withdrawals", {
    schema: { body: { type: "object", additionalProperties: false,
      properties: { amountUsdc: amountSchema, fundId: uuidSchema, shares: amountSchema } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const result = await requestWithdrawal(db(), chain, actor, idempotencyKey(request.headers["idempotency-key"]), request.body);
    reply.code(result.withdrawal.status === "CONFIRMED" ? 201 : 202);
    return { mode: "PAPER", ...result };
  });

  app.get<{ Params: { withdrawalId: string } }>("/v0/me/withdrawals/:withdrawalId", {
    schema: { params: { type: "object", required: ["withdrawalId"], properties: { withdrawalId: uuidSchema } } },
  }, async (request) => {
    const actor = await requireActor(request, db());
    return { mode: "PAPER", withdrawal: await withdrawalStatus(db(), chain, actor, request.params.withdrawalId) };
  });
}
