import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { joinFund, leaveFund } from "./crew.js";
import { ApiFault } from "./errors.js";
import { createFund, getFund, listFunds } from "./funds.js";
import { idempotencyKey } from "./request.js";

export function registerFundRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.post<{ Body: { name: string; description?: string } }>("/v0/funds", {
    schema: {
      body: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 3, maxLength: 80 },
          description: { type: "string", maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const key = idempotencyKey(request.headers["idempotency-key"]);
    const name = request.body.name.trim();
    if (name.length < 3) throw new ApiFault(400, "invalid_name", "Fund name is too short");
    const fund = await createFund(db(), actor, {
      name,
      description: request.body.description?.trim() ?? "",
    }, key);
    reply.code(201);
    return fund;
  });

  app.get("/v0/funds", async () => ({ mode: "PAPER", funds: await listFunds(db()) }));

  app.get<{ Params: { fundId: string } }>("/v0/funds/:fundId", async (request) => {
    return getFund(db(), request.params.fundId);
  });

  app.get<{ Params: { fundId: string } }>("/v0/funds/:fundId/policy", async (request) => {
    await getFund(db(), request.params.fundId);
    const result = await db().query(
      `SELECT version, max_order_bps, max_position_bps, drawdown_breaker_bps,
              allowed_instruments, effective_at
       FROM fund_policy_versions WHERE fund_id = $1 ORDER BY version DESC LIMIT 1`,
      [request.params.fundId],
    );
    return { mode: "PAPER", policy: result.rows[0] };
  });

  app.get<{ Params: { fundId: string } }>("/v0/funds/:fundId/holdings", async (request) => {
    await getFund(db(), request.params.fundId);
    const fund = await db().query<{ cash_usdc: string }>(
      "SELECT cash_usdc::text FROM funds WHERE id = $1", [request.params.fundId],
    );
    const positions = await db().query(
      `SELECT p.instrument_id, i.symbol, p.quantity::text, p.cost_basis_usdc::text
       FROM positions p JOIN instruments i ON i.id = p.instrument_id
       WHERE p.fund_id = $1 AND p.quantity > 0 ORDER BY i.symbol`,
      [request.params.fundId],
    );
    return { mode: "PAPER", cashUsdc: fund.rows[0]!.cash_usdc, positions: positions.rows };
  });

  app.post<{ Params: { fundId: string }; Body: { amountUsdc: string } }>("/v0/funds/:fundId/joins", {
    schema: { body: { type: "object", required: ["amountUsdc"], additionalProperties: false,
      properties: { amountUsdc: { type: "string" } } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const result = await joinFund(db(), actor, request.params.fundId, request.body.amountUsdc,
      idempotencyKey(request.headers["idempotency-key"]));
    reply.code(201);
    return result;
  });

  app.post<{ Params: { fundId: string }; Body: { shares: string } }>("/v0/funds/:fundId/exits", {
    schema: { body: { type: "object", required: ["shares"], additionalProperties: false,
      properties: { shares: { type: "string" } } } },
  }, async (request) => {
    const actor = await requireActor(request, db());
    return leaveFund(db(), actor, request.params.fundId, request.body.shares,
      idempotencyKey(request.headers["idempotency-key"]));
  });
}
