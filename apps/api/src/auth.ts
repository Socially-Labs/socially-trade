import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { inTransaction, ledgerAccountId, type DbPool } from "@socially/db";
import { ApiFault } from "./errors.js";
import { privyIdentity } from "./privy.js";

const VIRTUAL_ALLOWANCE = "10000.000000";
export interface Actor {
  id: string;
  subject: string;
  displayName: string;
  paperCash: string;
}

async function identity(request: FastifyRequest): Promise<{ subject: string; displayName: string }> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!token) throw new ApiFault(401, "unauthorized", "Bearer token required");
  return privyIdentity(token);
}

export async function requireActor(request: FastifyRequest, pool: DbPool): Promise<Actor> {
  const { subject, displayName } = await identity(request);
  return inTransaction(pool, async (client) => {
    const id = randomUUID();
    const inserted = await client.query<Actor>(
      `INSERT INTO users (id, auth_subject, display_name, paper_cash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (auth_subject) DO NOTHING
       RETURNING id, auth_subject AS subject, display_name AS "displayName", paper_cash::text AS "paperCash"`,
      [id, subject, displayName, VIRTUAL_ALLOWANCE],
    );
    if (inserted.rows[0]) {
      const eventId = randomUUID();
      await client.query(
        `INSERT INTO fund_events (id, type, payload) VALUES ($1, 'paper_budget_granted', $2)`,
        [eventId, { userId: id, amount: VIRTUAL_ALLOWANCE, asset: "USDC" }],
      );
      const userAccount = await ledgerAccountId(client, "USER", id, "USDC");
      const issuanceAccount = await ledgerAccountId(client, "ISSUANCE", "paper-budget", "USDC");
      await client.query(
        `INSERT INTO ledger_entries (event_id, account_id, amount)
         VALUES ($1, $2, $3), ($1, $4, -$3::numeric)`,
        [eventId, userAccount, VIRTUAL_ALLOWANCE, issuanceAccount],
      );
      return inserted.rows[0];
    }
    const existing = await client.query<Actor>(
      `SELECT id, auth_subject AS subject, display_name AS "displayName", paper_cash::text AS "paperCash"
       FROM users WHERE auth_subject = $1`,
      [subject],
    );
    return existing.rows[0]!;
  });
}
