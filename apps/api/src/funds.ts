import { createHash, randomUUID } from "node:crypto";
import { appendFundEvent, inTransaction, ledgerAccountId, type DbPool } from "@socially/db";
import { PAPER_MODE, type FundSummary } from "@socially/contracts";
import { Amount, MAX_PRICE_AGE_MS } from "@socially/domain";
import { ApiFault } from "./errors.js";
import { type Actor } from "./auth.js";

const CAPTAIN_SEED = "1000.000000";

interface FundRow {
  id: string;
  status: "ACTIVE" | "FROZEN" | "COMPLETED";
  name: string;
  captain_id: string;
  nav_usdc: string | null;
  share_price_usdc: string | null;
  valuation_status: "CURRENT" | "UNAVAILABLE" | null;
  priced_at: Date | null;
  has_positions: boolean;
  ends_at: Date;
}

function summary(row: FundRow): FundSummary {
  return {
    id: row.id,
    mode: PAPER_MODE,
    status: row.status,
    name: row.name,
    captainId: row.captain_id,
    nav: { value: row.nav_usdc ?? "0", asset: "USDC" },
    sharePrice: { value: row.share_price_usdc ?? "0", asset: "USDC" },
    valuationStatus: row.has_positions && (!row.priced_at || Date.now() - row.priced_at.getTime() > MAX_PRICE_AGE_MS)
      ? "UNAVAILABLE" : row.valuation_status ?? "UNAVAILABLE",
    trialEndsAt: row.ends_at.toISOString(),
  };
}

const fundReadSql = `
  SELECT f.id, f.status, f.name, f.captain_id, t.ends_at,
         n.nav_usdc::text, n.share_price_usdc::text, n.status AS valuation_status, n.priced_at,
         EXISTS (SELECT 1 FROM positions p WHERE p.fund_id = f.id AND p.quantity > 0) AS has_positions
  FROM funds f JOIN trials t ON t.fund_id = f.id
  LEFT JOIN LATERAL (
    SELECT nav_usdc, share_price_usdc, status, priced_at FROM nav_snapshots
    WHERE fund_id = f.id ORDER BY event_sequence DESC NULLS LAST, created_at DESC LIMIT 1
  ) n ON true`;

export async function listFunds(pool: DbPool, limit = 30): Promise<FundSummary[]> {
  const result = await pool.query<FundRow>(`${fundReadSql} ORDER BY f.created_at DESC LIMIT $1`, [limit]);
  return result.rows.map(summary);
}

export async function getFund(pool: DbPool, fundId: string): Promise<FundSummary> {
  const result = await pool.query<FundRow>(`${fundReadSql} WHERE f.id = $1`, [fundId]);
  if (!result.rows[0]) throw new ApiFault(404, "fund_not_found", "Fund not found");
  return summary(result.rows[0]);
}

export async function createFund(
  pool: DbPool,
  actor: Actor,
  input: { name: string; description: string },
  key: string,
): Promise<FundSummary> {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO api_idempotency (user_id, key, route, request_hash)
       VALUES ($1, $2, 'POST /v0/funds', $3) ON CONFLICT DO NOTHING`,
      [actor.id, key, hash],
    );
    const idempotency = await client.query<{
      route: string; request_hash: string; response: FundSummary | null;
    }>(
      `SELECT route, request_hash, response FROM api_idempotency
       WHERE user_id = $1 AND key = $2 FOR UPDATE`,
      [actor.id, key],
    );
    const prior = idempotency.rows[0]!;
    if (prior.route !== "POST /v0/funds" || prior.request_hash !== hash) {
      throw new ApiFault(409, "idempotency_conflict", "Idempotency key was used for another request");
    }
    if (prior.response) return prior.response;

    const captain = await client.query("SELECT 1 FROM captain_profiles WHERE user_id = $1", [actor.id]);
    if (!captain.rowCount) throw new ApiFault(403, "captain_required", "Create a Captain profile first");
    const user = await client.query<{ paper_cash: string }>(
      "SELECT paper_cash::text FROM users WHERE id = $1 FOR NO KEY UPDATE",
      [actor.id],
    );
    if (new Amount(user.rows[0]!.paper_cash).lt(CAPTAIN_SEED)) {
      throw new ApiFault(422, "insufficient_virtual_cash", "Not enough virtual USDC for the Captain seed");
    }
    const active = await client.query(
      `SELECT 1 FROM funds WHERE captain_id = $1 AND status IN ('ACTIVE', 'FROZEN')`,
      [actor.id],
    );
    if (active.rowCount) throw new ApiFault(409, "active_trial_exists", "Captain already has an active trial");

    const fundId = randomUUID();
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO funds (id, captain_id, name, description, cash_usdc, total_shares)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [fundId, actor.id, input.name, input.description, CAPTAIN_SEED],
    );
    await client.query(
      `INSERT INTO fund_policy_versions
       (fund_id, version, max_order_bps, max_position_bps, drawdown_breaker_bps,
        allowed_instruments, effective_at)
       VALUES ($1, 1, 1000, 2500, 3000, ARRAY['SOL'], $2)`,
      [fundId, startsAt],
    );
    await client.query(
      `INSERT INTO trials (fund_id, starts_at, ends_at, seed_usdc)
       VALUES ($1, $2, $3, $4)`,
      [fundId, startsAt, endsAt, CAPTAIN_SEED],
    );
    await client.query(
      `INSERT INTO fund_shares (fund_id, user_id, shares) VALUES ($1, $2, $3)`,
      [fundId, actor.id, CAPTAIN_SEED],
    );
    await client.query("UPDATE users SET paper_cash = paper_cash - $2::numeric WHERE id = $1", [actor.id, CAPTAIN_SEED]);
    const eventId = await appendFundEvent(client, fundId, "fund_started", {
      captainId: actor.id, seedUsdc: CAPTAIN_SEED, policyVersion: 1,
    });

    const userUsdc = await ledgerAccountId(client, "USER", actor.id, "USDC");
    const fundUsdc = await ledgerAccountId(client, "FUND", fundId, "USDC");
    const shareAsset = `SHARE:${fundId}`;
    const issuedShares = await ledgerAccountId(client, "ISSUANCE", fundId, shareAsset);
    const captainShares = await ledgerAccountId(client, "USER", actor.id, shareAsset);
    await client.query(
      `INSERT INTO ledger_entries (event_id, account_id, amount)
       VALUES ($1, $2, -$6::numeric), ($1, $3, $6),
              ($1, $4, -$6::numeric), ($1, $5, $6)`,
      [eventId, userUsdc, fundUsdc, issuedShares, captainShares, CAPTAIN_SEED],
    );
    await client.query(
      `INSERT INTO nav_snapshots (id, fund_id, nav_usdc, share_price_usdc, status, priced_at, event_sequence)
       VALUES ($1, $2, $3, 1, 'CURRENT', $4, 1)`,
      [randomUUID(), fundId, CAPTAIN_SEED, startsAt],
    );

    const created: FundSummary = {
      id: fundId,
      mode: PAPER_MODE,
      status: "ACTIVE",
      name: input.name,
      captainId: actor.id,
      nav: { value: CAPTAIN_SEED, asset: "USDC" },
      sharePrice: { value: "1", asset: "USDC" },
      valuationStatus: "CURRENT",
      trialEndsAt: endsAt.toISOString(),
    };
    await client.query(
      `UPDATE api_idempotency SET response = $3, status_code = 201
       WHERE user_id = $1 AND key = $2`,
      [actor.id, key, created],
    );
    return created;
  });
}
