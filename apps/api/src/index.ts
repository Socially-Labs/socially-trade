import Fastify from "fastify";
import { createPool } from "@socially/db";
import { ApiFault } from "./errors.js";
import { requireActor } from "./auth.js";
import { createFund, getFund, listFunds } from "./funds.js";
import { joinFund, leaveFund, myPositions } from "./crew.js";
import { cancelOrder, getOrder, listOrders, previewOrder, submitOrder } from "./orders.js";

const app = Fastify({ logger: true });
const pool = process.env.DATABASE_URL ? createPool() : null;
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

function db() {
  if (!pool) throw new ApiFault(503, "database_unconfigured", "DATABASE_URL is required");
  return pool;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new ApiFault(400, "idempotency_key_required", "Idempotency-Key must be 8-128 characters");
  }
  return value;
}

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

app.get("/v0/me", async (request) => {
  const actor = await requireActor(request, db());
  return {
    id: actor.id,
    displayName: actor.displayName,
    mode: "PAPER",
    paperCash: { value: actor.paperCash, asset: "USDC" },
  };
});

app.get("/v0/me/paper-balance", async (request) => {
  const actor = await requireActor(request, db());
  return { mode: "PAPER", available: { value: actor.paperCash, asset: "USDC" } };
});

app.get("/v0/me/paper-positions", async (request) => {
  const actor = await requireActor(request, db());
  return { mode: "PAPER", positions: await myPositions(db(), actor.id) };
});

app.post<{ Body: { handle: string; bio?: string } }>("/v0/captains", {
  schema: {
    body: {
      type: "object",
      required: ["handle"],
      additionalProperties: false,
      properties: {
        handle: { type: "string", pattern: "^[a-z0-9_]{3,24}$" },
        bio: { type: "string", maxLength: 500 },
      },
    },
  },
}, async (request, reply) => {
  const actor = await requireActor(request, db());
  const handle = request.body.handle;
  const bio = request.body.bio ?? "";
  const existing = await db().query<{ handle: string; bio: string }>(
    "SELECT handle, bio FROM captain_profiles WHERE user_id = $1",
    [actor.id],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].handle !== handle) {
      throw new ApiFault(409, "captain_profile_exists", "Captain profile already exists");
    }
    return { userId: actor.id, handle: existing.rows[0].handle, bio: existing.rows[0].bio };
  }
  await db().query(
    "INSERT INTO captain_profiles (user_id, handle, bio) VALUES ($1, $2, $3)",
    [actor.id, handle, bio],
  );
  reply.code(201);
  return { userId: actor.id, handle, bio };
});

app.get<{ Params: { captainId: string } }>("/v0/captains/:captainId", async (request) => {
  const result = await db().query<{ user_id: string; handle: string; bio: string }>(
    "SELECT user_id, handle, bio FROM captain_profiles WHERE user_id = $1",
    [request.params.captainId],
  );
  if (!result.rows[0]) throw new ApiFault(404, "captain_not_found", "Captain not found");
  return { userId: result.rows[0].user_id, handle: result.rows[0].handle, bio: result.rows[0].bio };
});

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

const orderBody = {
  type: "object", required: ["side", "instrumentId", "notionalUsdc"], additionalProperties: false,
  properties: {
    side: { type: "string", enum: ["BUY", "SELL"] },
    instrumentId: { type: "string", minLength: 1, maxLength: 32 },
    notionalUsdc: { type: "string" },
  },
} as const;

type PaperOrderBody = { side: "BUY" | "SELL"; instrumentId: string; notionalUsdc: string };

app.post<{ Params: { fundId: string }; Body: PaperOrderBody }>(
  "/v0/funds/:fundId/orders/preview", { schema: { body: orderBody } },
  async (request) => {
    const actor = await requireActor(request, db());
    return previewOrder(db(), actor, request.params.fundId, request.body);
  },
);

app.post<{ Params: { fundId: string }; Body: PaperOrderBody }>(
  "/v0/funds/:fundId/orders", { schema: { body: orderBody } },
  async (request, reply) => {
    const actor = await requireActor(request, db());
    const result = await submitOrder(db(), actor, request.params.fundId, request.body,
      idempotencyKey(request.headers["idempotency-key"]));
    reply.code(202);
    return result;
  },
);

app.get<{ Params: { fundId: string } }>("/v0/funds/:fundId/orders", async (request) => {
  await getFund(db(), request.params.fundId);
  return { mode: "PAPER", orders: await listOrders(db(), request.params.fundId) };
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

app.get<{ Params: { fundId: string }; Querystring: { after?: string } }>(
  "/v0/funds/:fundId/events",
  async (request) => {
    const rawAfter = request.query.after ?? "0";
    const after = Number(rawAfter);
    if (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(after) || after < 0) {
      throw new ApiFault(400, "invalid_cursor", "after must be a nonnegative integer");
    }
    await getFund(db(), request.params.fundId);
    const events = await db().query(
      `SELECT id, sequence, type, payload, recorded_at FROM fund_events
       WHERE fund_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT 100`,
      [request.params.fundId, after],
    );
    return { mode: "PAPER", events: events.rows };
  },
);

app.addHook("onClose", async () => {
  await pool?.end();
});

await app.listen({
  port,
  host: process.env.HOST ?? (process.env.DEV_AUTH_TOKEN ? "127.0.0.1" : "0.0.0.0"),
});
