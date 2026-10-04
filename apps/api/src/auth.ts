import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { inTransaction, ledgerAccountId, type DbPool } from "@socially/db";
import { ApiFault } from "./errors.js";
import { privyIdentity } from "./privy.js";

const VIRTUAL_ALLOWANCE = "10000.000000";
const jwksUrl = process.env.AUTH_JWKS_URL;
const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;

export interface Actor {
  id: string;
  subject: string;
  displayName: string;
  paperCash: string;
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function identity(request: FastifyRequest, privyOnly = false): Promise<{ subject: string; displayName: string }> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!token) throw new ApiFault(401, "unauthorized", "Bearer token required");

  const devToken = process.env.DEV_AUTH_TOKEN;
  if (!privyOnly && process.env.NODE_ENV !== "production" && devToken && sameSecret(token, devToken)) {
    const subject = request.headers["x-dev-subject"];
    if (typeof subject !== "string" || !/^dev:[a-z0-9_-]{3,40}$/.test(subject)) {
      throw new ApiFault(400, "invalid_dev_subject", "X-Dev-Subject must look like dev:alice");
    }
    return { subject, displayName: subject.slice(4) };
  }

  if (privyOnly || process.env.AUTH_PROVIDER === "privy") return privyIdentity(token);
  if (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== "jwt") {
    throw new ApiFault(503, "auth_unconfigured", "AUTH_PROVIDER must be jwt or privy");
  }

  if (!jwks || !process.env.AUTH_ISSUER || !process.env.AUTH_AUDIENCE) {
    throw new ApiFault(503, "auth_unconfigured", "JWT verification is not configured");
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: process.env.AUTH_ISSUER,
      audience: process.env.AUTH_AUDIENCE,
    });
    if (!payload.sub) throw new Error("Token has no subject");
    return {
      subject: payload.sub,
      displayName: typeof payload.name === "string" ? payload.name.slice(0, 80) : "Trader",
    };
  } catch {
    throw new ApiFault(401, "unauthorized", "Invalid bearer token");
  }
}

export async function requireActor(request: FastifyRequest, pool: DbPool, privyOnly = false): Promise<Actor> {
  const { subject, displayName } = await identity(request, privyOnly);
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
