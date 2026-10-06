import type { FastifyInstance } from "fastify";
import { inTransaction, type DbClient, type DbPool } from "@socially/db";
import { Amount, MAX_PRICE_AGE_MS, calculatePerformance, personalPerformance, type PerformancePoint } from "@socially/domain";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";

interface FundPerformanceRow {
  id: string; name: string; captain_id: string; status: string;
  starts_at: Date; ends_at: Date; total_shares: string;
  final_nav_usdc: string | null; final_share_price_usdc: string | null;
  has_positions: boolean;
}
interface SnapshotRow {
  sequence: string; recorded_at: Date; priced_at: Date; status: string;
  nav_usdc: string | null; share_price_usdc: string | null; performance_fee_factor: string;
}
const snapshotSql = `SELECT event_sequence::text AS sequence, created_at AS recorded_at, priced_at,
  status, nav_usdc::text, share_price_usdc::text, performance_fee_factor::text
  FROM nav_snapshots WHERE fund_id=$1`;
function point(row: SnapshotRow): PerformancePoint | null {
  if (row.status !== "CURRENT" || row.nav_usdc === null || row.share_price_usdc === null) return null;
  return { sequence: row.sequence, recordedAt: row.recorded_at.toISOString(), pricedAt: row.priced_at.toISOString(),
    navUsdc: row.nav_usdc, sharePriceUsdc: row.share_price_usdc, performanceFeeFactor: row.performance_fee_factor };
}

async function readPerformance(client: DbClient, fundId: string, now: Date) {
  const result = await client.query<FundPerformanceRow>(`SELECT f.id,f.name,f.captain_id,f.status,
    f.total_shares::text,f.final_nav_usdc::text,f.final_share_price_usdc::text,t.starts_at,t.ends_at,
    EXISTS(SELECT 1 FROM positions p WHERE p.fund_id=f.id AND p.quantity>0) AS has_positions
    FROM funds f JOIN trials t ON t.fund_id=f.id WHERE f.id=$1`, [fundId]);
  const fund = result.rows[0];
  if (!fund) throw new ApiFault(404, "fund_not_found", "Fund not found");
  const snapshots = await client.query<SnapshotRow>(`${snapshotSql} ORDER BY event_sequence ASC`, [fundId]);
  const latest = snapshots.rows.at(-1);
  const points = snapshots.rows.map(point).filter((p): p is PerformancePoint => p !== null);
  const historical = points.at(-1) ?? null;
  const completed = fund.status === "COMPLETED";
  // Terminal NAV is the amount liquidated and distributed, not the now-empty fund's cash.
  const terminal = completed && fund.final_nav_usdc !== null && fund.final_share_price_usdc !== null && historical
    ? { ...historical, navUsdc: fund.final_nav_usdc, sharePriceUsdc: fund.final_share_price_usdc } : null;
  if (terminal && points.length) points[points.length - 1] = terminal;
  const available = completed ? terminal !== null : !!latest && latest.status === "CURRENT" &&
    latest.nav_usdc !== null && latest.share_price_usdc !== null && latest.priced_at.getTime() <= now.getTime() &&
    (!fund.has_positions || now.getTime() - latest.priced_at.getTime() <= MAX_PRICE_AGE_MS);
  const currentPoint = available ? terminal ?? (latest ? point(latest) : null) : null;
  const historicalMetrics = calculatePerformance(points, completed && terminal ? new Date(terminal.recordedAt) : now);
  const orders = await client.query<{ status: string; count: number }>(`SELECT status,count(*)::integer AS count
    FROM orders WHERE fund_id=$1 GROUP BY status`, [fundId]);
  const fees = await client.query<{ total: string; count: number; last: Date | null; captain_shares: string; protocol_shares: string }>(`SELECT
    coalesce(sum(fee_usdc),0)::text AS total,count(*)::integer AS count,max(fee_day)::timestamptz AS last,
    coalesce(sum(captain_shares),0)::text AS captain_shares,coalesce(sum(protocol_shares),0)::text AS protocol_shares
    FROM fee_assessments WHERE fund_id=$1`, [fundId]);
  const tradingFees = await client.query<{ fees: string; filled_notional: string }>(`SELECT
    coalesce(sum(fl.fee_usdc),0)::text AS fees,coalesce(sum(o.notional_usdc),0)::text AS filled_notional
    FROM orders o JOIN fills fl ON fl.order_id=o.id WHERE o.fund_id=$1`, [fundId]);
  const elapsed = Math.max(0, (Math.min(now.getTime(), fund.ends_at.getTime()) - fund.starts_at.getTime()) / 86_400_000);
  return {
    fund,
    response: {
      mode: "PAPER", fundId, fundName: fund.name, captainId: fund.captain_id, status: fund.status,
      totalShares: fund.total_shares,
      valuationStatus: available ? (completed ? "FINAL" : "CURRENT") : "UNAVAILABLE",
      current: currentPoint ? { ...currentPoint, ...historicalMetrics } : null,
      latestHistorical: points.length ? { ...points.at(-1), ...historicalMetrics } : null,
      methodology: {
        version: 1, netReturn: "Unit share-price return after trading costs and performance fees; excludes subscriptions and redemptions.",
        grossReturn: "Unit share-price return before performance fees, including trading costs.",
        drawdown: "Measured from recorded net share-price snapshots; intraperiod movements between snapshots are not observed.",
        periods: "Baseline is the most recent recorded snapshot at or before the period boundary. Missing history returns null.",
        chartGaps: "History entries marked UNAVAILABLE represent gaps. Do not interpolate returns through missing valuations.",
        unavailable: "Stale position prices suppress current performance. Historical values retain their original valuation timestamps.",
      },
      trial: { startsAt: fund.starts_at.toISOString(), endsAt: fund.ends_at.toISOString(),
        elapsedDays: elapsed, remainingDays: completed ? 0 : Math.max(0, (fund.ends_at.getTime() - now.getTime()) / 86_400_000),
        settlementPending: !completed && now >= fund.ends_at },
      orders: Object.fromEntries(["PENDING", "FILLED", "PARTIALLY_FILLED", "REJECTED", "CANCELLED"].map((status) =>
        [status.toLowerCase(), orders.rows.find((row) => row.status === status)?.count ?? 0])),
      fees: { simulated: true, modelVersion: 1, performanceFeePercent: "10", captainShareOfFeePercent: "80", protocolShareOfFeePercent: "20",
        assessmentPolicy: "First eligible positive gain above the post-fee high-water mark per UTC date; at most one paid assessment each day. Zero profit does not consume the date.",
        performanceFeeUsdc: fees.rows[0]!.total, captainFeeShares: fees.rows[0]!.captain_shares,
        protocolFeeShares: fees.rows[0]!.protocol_shares, assessmentCount: fees.rows[0]!.count,
        lastAssessmentAt: fees.rows[0]!.last?.toISOString() ?? null, tradingFeeUsdc: tradingFees.rows[0]!.fees,
        filledNotionalUsdc: tradingFees.rows[0]!.filled_notional },
    },
  };
}

async function readConsistently<T>(pool: DbPool, work: (client: DbClient) => Promise<T>): Promise<T> {
  return inTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return work(client);
  });
}

async function readPersonal(client: DbClient, actorId: string, fundId: string, loaded: Awaited<ReturnType<typeof readPerformance>>) {
  const { fund, response } = loaded;
  const events = await client.query<{ type: string; payload: Record<string, unknown> }>(`SELECT type,payload
    FROM fund_events WHERE fund_id=$1 AND type IN ('fund_started','crew_joined','crew_left','trial_completed') ORDER BY sequence`, [fundId]);
  let contributions = new Amount(0), withdrawals = new Amount(0);
  for (const { type, payload } of events.rows) {
    if (type === "fund_started" && payload.captainId === actorId) contributions = contributions.plus(String(payload.seedUsdc));
    if (type === "crew_joined" && payload.userId === actorId) contributions = contributions.plus(String(payload.amountUsdc));
    if (type === "crew_left" && payload.userId === actorId) withdrawals = withdrawals.plus(String(payload.payoutUsdc));
    if (type === "trial_completed" && Array.isArray(payload.payouts)) {
      for (const payout of payload.payouts as { userId: string; payoutUsdc: string }[]) {
        if (payout.userId === actorId) withdrawals = withdrawals.plus(payout.payoutUsdc);
      }
    }
  }
  const shareRow = await client.query<{ shares: string }>("SELECT shares::text FROM fund_shares WHERE fund_id=$1 AND user_id=$2", [fundId, actorId]);
  const shares = shareRow.rows[0]?.shares ?? "0";
  const currentValue = new Amount(shares).eq(0) || fund.status === "COMPLETED" ? "0"
    : response.current ? new Amount(shares).mul(response.current.sharePriceUsdc).toString() : null;
  return { mode: "PAPER", fundId, shares, valuationStatus: response.valuationStatus,
    ...personalPerformance(contributions.toString(), withdrawals.toString(), currentValue),
    historicalPositionValueUsdc: response.latestHistorical ? new Amount(shares).mul(response.latestHistorical.sharePriceUsdc!).toFixed(6) : null,
    historicalPricedAt: response.latestHistorical?.pricedAt ?? null };
}

export function registerPerformanceRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Params: { fundId: string } }>("/v0/funds/:fundId/performance", async (request) =>
    readConsistently(db(), async (client) => (await readPerformance(client, request.params.fundId, new Date())).response));

  app.get<{ Params: { fundId: string }; Querystring: { after?: string; limit?: string } }>("/v0/funds/:fundId/history", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      after: { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
      limit: { type: "string", pattern: "^([1-9]|[1-9][0-9]|100)$" },
    } } },
  }, async (request) => readConsistently(db(), async (client) => {
    const fundId = request.params.fundId;
    if (!(await client.query("SELECT 1 FROM funds WHERE id=$1", [fundId])).rowCount) throw new ApiFault(404, "fund_not_found", "Fund not found");
    const after = request.query.after ?? "0";
    if (BigInt(after) > 9223372036854775807n) throw new ApiFault(400, "invalid_cursor", "Cursor exceeds supported range");
    const limit = Number(request.query.limit ?? "100");
    const rows = await client.query<SnapshotRow>(`${snapshotSql} AND event_sequence>$2 ORDER BY event_sequence ASC LIMIT $3`, [fundId, after, limit + 1]);
    const page = rows.rows.slice(0, limit);
    return { mode: "PAPER", fundId, points: page.map((row) => ({
      sequence: row.sequence, recordedAt: row.recorded_at.toISOString(), pricedAt: row.priced_at.toISOString(),
      valuationStatus: row.status, navUsdc: row.status === "CURRENT" ? row.nav_usdc : null,
      sharePriceUsdc: row.status === "CURRENT" ? row.share_price_usdc : null,
      performanceFeeFactor: row.performance_fee_factor,
      grossSharePriceUsdc: row.status !== "CURRENT" || row.share_price_usdc === null ? null : new Amount(row.share_price_usdc).mul(row.performance_fee_factor).toFixed(18),
    })), nextCursor: rows.rows.length > limit ? page.at(-1)!.sequence : null };
  }));

  app.get<{ Params: { fundId: string } }>("/v0/me/funds/:fundId/performance", async (request) => {
    const actor = await requireActor(request, db());
    return readConsistently(db(), async (client) => {
      const fundId = request.params.fundId;
      return readPersonal(client, actor.id, fundId, await readPerformance(client, fundId, new Date()));
    });
  });

  app.get("/v0/me/paper-record", async request => {
    const actor = await requireActor(request, db());
    return readConsistently(db(), async client => {
      const funds = await client.query<{ id: string }>(`SELECT f.id FROM funds f JOIN fund_shares s ON s.fund_id=f.id
        WHERE s.user_id=$1 ORDER BY f.created_at DESC`, [actor.id]);
      const records = [];
      for (const fund of funds.rows) {
        const loaded = await readPerformance(client, fund.id, new Date());
        records.push({ fund: loaded.response, personal: await readPersonal(client, actor.id, fund.id, loaded) });
      }
      return { mode: "PAPER", records };
    });
  });

  app.get<{ Params: { captainId: string } }>("/v0/captains/:captainId/paper-record", async (request) =>
    readConsistently(db(), async (client) => {
      if (!(await client.query("SELECT 1 FROM users u WHERE u.id=$1 AND (u.role='captain' OR EXISTS(SELECT 1 FROM funds f WHERE f.captain_id=u.id))", [request.params.captainId])).rowCount) throw new ApiFault(404, "captain_not_found", "Captain not found");
      const funds = await client.query<{ id: string }>("SELECT id FROM funds WHERE captain_id=$1 ORDER BY created_at DESC", [request.params.captainId]);
      const records = [];
      for (const fund of funds.rows) records.push((await readPerformance(client, fund.id, new Date())).response);
      return { mode: "PAPER", captainId: request.params.captainId, records,
        disclaimer: "Simulated results include recorded fees and costs. Trials are independent records; returns are not combined across different funds." };
    }));

  app.get("/v0/funds/rankings", async () => readConsistently(db(), async (client) => {
    const ids = await client.query<{ id: string }>("SELECT id FROM funds ORDER BY created_at DESC LIMIT 100");
    const candidates = [];
    for (const { id } of ids.rows) {
      const { response } = await readPerformance(client, id, new Date());
      if (response.current && response.trial.elapsedDays >= 7) candidates.push(response);
    }
    candidates.sort((a, b) => new Amount(b.current!.sinceInception!.netReturnPercent ?? "0")
      .cmp(a.current!.sinceInception!.netReturnPercent ?? "0") || a.fundId.localeCompare(b.fundId));
    return { mode: "PAPER", rankingMethod: "SINCE_INCEPTION_NET_RETURN", minimumAgeDays: 7,
      universe: "Most recent 100 funds; only current or final valuations, at least 7 days old.",
      disclaimer: "Not risk-adjusted. Compare age, recorded drawdown and trade counts alongside returns.",
      funds: candidates.map((fund, index) => ({ rank: index + 1, ...fund })) };
  }));
}
