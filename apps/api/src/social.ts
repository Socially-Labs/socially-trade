import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { appendFundEvent, inTransaction, type DbClient, type DbPool } from "@socially/db";
import { beginIdempotent, finishIdempotent } from "./accounting.js";
import { requireActor, type Actor } from "./auth.js";
import { ApiFault } from "./errors.js";
import { getFund } from "./funds.js";

type MessageKind = "CHAT" | "TRADE_NOTE";

interface MessageRow {
  id: string;
  kind: MessageKind;
  body: string;
  author_id: string;
  linked_order_id: string | null;
  corrects_message_id: string | null;
  event_sequence: string;
  created_at: Date;
}

function cursor(value: string | undefined): number {
  const raw = value ?? "0";
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    throw new ApiFault(400, "invalid_cursor", "after must be a nonnegative integer");
  }
  return parsed;
}

function body(value: string): string {
  const clean = value.trim();
  if (clean.length < 1 || clean.length > 2000) {
    throw new ApiFault(400, "invalid_message", "Message must contain 1-2000 characters");
  }
  return clean;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new ApiFault(400, "idempotency_key_required", "Idempotency-Key must be 8-128 characters");
  }
  return value;
}

async function fundCaptain(client: DbClient, fundId: string): Promise<string> {
  const fund = await client.query<{ captain_id: string }>(
    "SELECT captain_id FROM funds WHERE id = $1", [fundId],
  );
  if (!fund.rows[0]) throw new ApiFault(404, "fund_not_found", "Fund not found");
  return fund.rows[0].captain_id;
}

async function canChat(client: DbClient, actor: Actor, fundId: string): Promise<void> {
  if (await fundCaptain(client, fundId) === actor.id) return;
  const membership = await client.query(
    "SELECT 1 FROM fund_shares WHERE fund_id = $1 AND user_id = $2 AND shares > 0",
    [fundId, actor.id],
  );
  if (!membership.rowCount) throw new ApiFault(403, "crew_required", "Join the fund to post in its chat");
}

function publicMessage(row: MessageRow) {
  return {
    id: row.id,
    kind: row.kind,
    body: row.body,
    authorId: row.author_id,
    linkedOrderId: row.linked_order_id,
    correctsMessageId: row.corrects_message_id,
    sequence: row.event_sequence,
    createdAt: row.created_at.toISOString(),
  };
}

async function publish(
  pool: DbPool,
  actor: Actor,
  fundId: string,
  input: { kind: MessageKind; body: string; linkedOrderId?: string; correctsMessageId?: string },
  key: string,
) {
  const clean = body(input.body);
  return inTransaction(pool, async (client) => {
    const route = input.kind === "CHAT"
      ? `POST /v0/funds/${fundId}/messages`
      : `POST /v0/funds/${fundId}/orders/${input.linkedOrderId}/notes`;
    const prior = await beginIdempotent<ReturnType<typeof publicMessage>>(
      client, actor.id, key, route,
      { kind: input.kind, body: clean, linkedOrderId: input.linkedOrderId ?? null,
        correctsMessageId: input.correctsMessageId ?? null },
    );
    if (prior) return { mode: "PAPER" as const, message: prior };

    const captainId = await fundCaptain(client, fundId);
    if (input.kind === "CHAT") {
      await canChat(client, actor, fundId);
    } else {
      if (captainId !== actor.id) throw new ApiFault(403, "captain_required", "Only the Captain can post order notes");
      const order = await client.query(
        "SELECT 1 FROM orders WHERE id = $1 AND fund_id = $2", [input.linkedOrderId, fundId],
      );
      if (!order.rowCount) throw new ApiFault(404, "order_not_found", "Order not found");
      if (input.correctsMessageId) {
        const original = await client.query(
          `SELECT 1 FROM messages WHERE id = $1 AND fund_id = $2 AND kind = 'TRADE_NOTE'
           AND linked_order_id = $3 AND author_id = $4`,
          [input.correctsMessageId, fundId, input.linkedOrderId, actor.id],
        );
        if (!original.rowCount) throw new ApiFault(404, "note_not_found", "Note to correct was not found");
      }
    }

    const messageId = randomUUID();
    const eventId = await appendFundEvent(client, fundId,
      input.kind === "CHAT" ? "chat_message_posted" : "trade_note_posted",
      { messageId, authorId: actor.id, linkedOrderId: input.linkedOrderId ?? null,
        correctsMessageId: input.correctsMessageId ?? null },
    );
    const inserted = await client.query<MessageRow>(
      `INSERT INTO messages
       (id, fund_id, author_id, body, linked_order_id, kind, corrects_message_id, event_sequence)
       SELECT $1, $2, $3, $4, $5, $6, $7, sequence FROM fund_events WHERE id = $8
       RETURNING id, kind, body, author_id, linked_order_id, corrects_message_id,
                 event_sequence::text, created_at`,
      [messageId, fundId, actor.id, clean, input.linkedOrderId ?? null,
        input.kind, input.correctsMessageId ?? null, eventId],
    );
    const message = publicMessage(inserted.rows[0]!);
    await finishIdempotent(client, actor.id, key, message, 201);
    return { mode: "PAPER" as const, message };
  });
}

async function listMessages(pool: DbPool, fundId: string, after: number, kind?: MessageKind) {
  const result = await pool.query<MessageRow>(
    `SELECT id, kind, body, author_id, linked_order_id, corrects_message_id,
            event_sequence::text, created_at
     FROM messages WHERE fund_id = $1 AND event_sequence > $2
       AND moderation_status = 'VISIBLE' AND ($3::text IS NULL OR kind = $3)
     ORDER BY event_sequence ASC LIMIT 100`,
    [fundId, after, kind ?? null],
  );
  return result.rows.map(publicMessage);
}

export function registerSocialRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Params: { fundId: string }; Querystring: { after?: string } }>(
    "/v0/funds/:fundId/messages", async (request) => {
      const after = cursor(request.query.after);
      await getFund(db(), request.params.fundId);
      return { mode: "PAPER", messages: await listMessages(db(), request.params.fundId, after) };
    },
  );
  app.get<{ Params: { fundId: string }; Querystring: { after?: string } }>(
    "/v0/funds/:fundId/decisions", async (request) => {
      const after = cursor(request.query.after);
      await getFund(db(), request.params.fundId);
      return { mode: "PAPER", notes: await listMessages(db(), request.params.fundId, after, "TRADE_NOTE") };
    },
  );
  app.post<{ Params: { fundId: string }; Body: { body: string } }>(
    "/v0/funds/:fundId/messages", {
      schema: { body: { type: "object", required: ["body"], additionalProperties: false,
        properties: { body: { type: "string", minLength: 1, maxLength: 2000 } } } },
    }, async (request, reply) => {
      const actor = await requireActor(request, db());
      const result = await publish(db(), actor, request.params.fundId,
        { kind: "CHAT", body: request.body.body }, idempotencyKey(request.headers["idempotency-key"]));
      reply.code(201);
      return result;
    },
  );
  app.post<{ Params: { fundId: string; orderId: string }; Body: { body: string; correctsMessageId?: string } }>(
    "/v0/funds/:fundId/orders/:orderId/notes", {
      schema: { body: { type: "object", required: ["body"], additionalProperties: false,
        properties: { body: { type: "string", minLength: 1, maxLength: 2000 },
          correctsMessageId: { type: "string", format: "uuid" } } } },
    }, async (request, reply) => {
      const actor = await requireActor(request, db());
      const result = await publish(db(), actor, request.params.fundId,
        { kind: "TRADE_NOTE", body: request.body.body, linkedOrderId: request.params.orderId,
          correctsMessageId: request.body.correctsMessageId },
        idempotencyKey(request.headers["idempotency-key"]));
      reply.code(201);
      return result;
    },
  );
}
