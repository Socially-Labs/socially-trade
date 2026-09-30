import { randomUUID } from "node:crypto";
import type { DbPool } from "@socially/db";
import { appendFundEvent, inTransaction, ledgerAccountId } from "@socially/db";
import { Amount, fixed, MAX_PRICE_AGE_MS, parsePositiveAmount, SHARE_DECIMALS, USDC_DECIMALS } from "@socially/domain";
import { type Actor } from "./auth.js";
import { beginIdempotent, finishIdempotent, saveNav, valueFund } from "./accounting.js";
import { ApiFault } from "./errors.js";

interface LockedFund {
  id: string;
  captain_id: string;
  status: string;
  cash_usdc: string;
  total_shares: string;
  ends_at: Date;
}

async function lockFund(client: import("@socially/db").DbClient, fundId: string): Promise<LockedFund> {
  const result = await client.query<LockedFund>(
    `SELECT f.id, f.captain_id, f.status, f.cash_usdc::text, f.total_shares::text, t.ends_at
     FROM funds f JOIN trials t ON t.fund_id = f.id
     WHERE f.id = $1 FOR UPDATE OF f`,
    [fundId],
  );
  const fund = result.rows[0];
  if (!fund) throw new ApiFault(404, "fund_not_found", "Fund not found");
  return fund;
}

export interface CrewChange {
  mode: "PAPER";
  fundId: string;
  eventId: string;
  shares: string;
  virtualUsdc: string;
  sharePrice: string;
}

export async function joinFund(
  pool: DbPool,
  actor: Actor,
  fundId: string,
  rawAmount: unknown,
  key: string,
): Promise<CrewChange> {
  let amount: Amount;
  try { amount = parsePositiveAmount(rawAmount, USDC_DECIMALS); }
  catch { throw new ApiFault(400, "invalid_amount", "amountUsdc must be a positive decimal string with at most 6 places"); }
  if (amount.lt(1)) throw new ApiFault(400, "amount_too_small", "Minimum virtual deposit is 1 USDC");
  const amountUsdc = fixed(amount, USDC_DECIMALS);
  return inTransaction(pool, async (client) => {
    const prior = await beginIdempotent<CrewChange>(client, actor.id, key, `POST /v0/funds/${fundId}/joins`, { amountUsdc });
    if (prior) return prior;
    const user = await client.query<{ paper_cash: string }>(
      "SELECT paper_cash::text FROM users WHERE id = $1 FOR UPDATE",
      [actor.id],
    );
    if (new Amount(user.rows[0]!.paper_cash).lt(amount)) {
      throw new ApiFault(422, "insufficient_virtual_cash", "Not enough virtual USDC");
    }
    const fund = await lockFund(client, fundId);
    if (fund.status !== "ACTIVE" || fund.ends_at.getTime() <= Date.now()) {
      throw new ApiFault(409, "fund_not_active", "Fund is not accepting joins");
    }
    if (fund.captain_id === actor.id) throw new ApiFault(403, "captain_seed_fixed", "Captain stake is fixed for this trial");
    const valuation = await valueFund(client, fund);
    const shares = new Amount(fixed(amount.div(valuation.sharePrice), SHARE_DECIMALS));
    if (shares.lte(0)) throw new ApiFault(422, "shares_too_small", "Deposit would mint no shares");
    const newSupply = new Amount(fund.total_shares).plus(shares);
    const newNav = valuation.nav.plus(amount);
    await client.query("UPDATE users SET paper_cash = paper_cash - $2::numeric WHERE id = $1", [actor.id, amountUsdc]);
    await client.query(
      `UPDATE funds SET cash_usdc = cash_usdc + $2::numeric,
       total_shares = total_shares + $3::numeric WHERE id = $1`,
      [fundId, amountUsdc, fixed(shares, SHARE_DECIMALS)],
    );
    await client.query(
      `INSERT INTO fund_shares (fund_id, user_id, shares) VALUES ($1, $2, $3)
       ON CONFLICT (fund_id, user_id) DO UPDATE SET shares = fund_shares.shares + EXCLUDED.shares`,
      [fundId, actor.id, fixed(shares, SHARE_DECIMALS)],
    );
    const eventId = await appendFundEvent(client, fundId, "crew_joined", {
      userId: actor.id, amountUsdc, shares: fixed(shares, SHARE_DECIMALS),
    });
    const userUsdc = await ledgerAccountId(client, "USER", actor.id, "USDC");
    const fundUsdc = await ledgerAccountId(client, "FUND", fundId, "USDC");
    const shareAsset = `SHARE:${fundId}`;
    const issuance = await ledgerAccountId(client, "ISSUANCE", fundId, shareAsset);
    const userShares = await ledgerAccountId(client, "USER", actor.id, shareAsset);
    await client.query(
      `INSERT INTO ledger_entries (event_id, account_id, amount)
       VALUES ($1, $2, -$6::numeric), ($1, $3, $6),
              ($1, $4, -$7::numeric), ($1, $5, $7)`,
      [eventId, userUsdc, fundUsdc, issuance, userShares, amountUsdc, fixed(shares, SHARE_DECIMALS)],
    );
    await saveNav(client, fundId, newNav, newSupply, valuation.pricedAt);
    const response: CrewChange = {
      mode: "PAPER", fundId, eventId, shares: fixed(shares, SHARE_DECIMALS),
      virtualUsdc: amountUsdc, sharePrice: fixed(newNav.div(newSupply), SHARE_DECIMALS),
    };
    await finishIdempotent(client, actor.id, key, response, 201);
    return response;
  });
}

export async function leaveFund(
  pool: DbPool,
  actor: Actor,
  fundId: string,
  rawShares: unknown,
  key: string,
): Promise<CrewChange> {
  let shares: Amount;
  try { shares = parsePositiveAmount(rawShares, SHARE_DECIMALS); }
  catch { throw new ApiFault(400, "invalid_shares", "shares must be a positive decimal string with at most 18 places"); }
  const sharesText = fixed(shares, SHARE_DECIMALS);
  return inTransaction(pool, async (client) => {
    const prior = await beginIdempotent<CrewChange>(client, actor.id, key, `POST /v0/funds/${fundId}/exits`, { shares: sharesText });
    if (prior) return prior;
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [actor.id]);
    const fund = await lockFund(client, fundId);
    if (fund.captain_id === actor.id) throw new ApiFault(403, "captain_stake_locked", "Captain stake stays in the trial");
    const held = await client.query<{ shares: string }>(
      "SELECT shares::text FROM fund_shares WHERE fund_id = $1 AND user_id = $2",
      [fundId, actor.id],
    );
    if (!held.rows[0] || new Amount(held.rows[0].shares).lt(shares)) {
      throw new ApiFault(422, "insufficient_shares", "Not enough fund shares");
    }
    const valuation = await valueFund(client, fund);
    const supply = new Amount(fund.total_shares);
    const fraction = shares.div(supply);
    const cashPart = new Amount(fixed(
      valuation.positions.length === 0
        ? shares.mul(valuation.sharePrice)
        : new Amount(fund.cash_usdc).mul(fraction),
      USDC_DECIMALS,
    ));
    const exitSpread = new Amount("0.002");
    let proceeds = new Amount(0);
    let markedAssetsRemoved = new Amount(0);
    const sales: Array<{ instrumentId: string; quantity: string; proceeds: string; costBasis: string }> = [];
    for (const position of valuation.positions) {
      const quantity = new Amount(fixed(position.quantity.mul(fraction), position.decimals));
      if (quantity.lte(0)) continue;
      const marked = quantity.mul(position.price);
      const saleProceeds = new Amount(fixed(marked.mul(new Amount(1).minus(exitSpread)), USDC_DECIMALS));
      const basis = new Amount(fixed(position.costBasis.mul(quantity).div(position.quantity), SHARE_DECIMALS));
      markedAssetsRemoved = markedAssetsRemoved.plus(marked);
      proceeds = proceeds.plus(saleProceeds);
      sales.push({ instrumentId: position.instrumentId, quantity: fixed(quantity, position.decimals),
        proceeds: fixed(saleProceeds, USDC_DECIMALS), costBasis: fixed(basis, SHARE_DECIMALS) });
    }
    const payout = cashPart.plus(proceeds);
    if (payout.lte(0)) throw new ApiFault(422, "exit_too_small", "Exit would pay no virtual USDC");
    const newSupply = supply.minus(shares);
    if (newSupply.lte(0)) throw new ApiFault(409, "fund_seed_required", "Fund cannot lose all shares");

    const eventId = await appendFundEvent(client, fundId, "crew_left", {
      userId: actor.id, shares: sharesText, payoutUsdc: fixed(payout, USDC_DECIMALS),
      exitCostUsdc: fixed(markedAssetsRemoved.minus(proceeds), USDC_DECIMALS), sales,
    });
    const fundUsdc = await ledgerAccountId(client, "FUND", fundId, "USDC");
    const userUsdc = await ledgerAccountId(client, "USER", actor.id, "USDC");
    for (const sale of sales) {
      await client.query(
        `UPDATE positions SET quantity = quantity - $3::numeric,
         cost_basis_usdc = cost_basis_usdc - $4::numeric
         WHERE fund_id = $1 AND instrument_id = $2`,
        [fundId, sale.instrumentId, sale.quantity, sale.costBasis],
      );
      const fundAsset = await ledgerAccountId(client, "FUND", fundId, sale.instrumentId);
      const marketAsset = await ledgerAccountId(client, "MARKET", "paper-market", sale.instrumentId);
      const marketUsdc = await ledgerAccountId(client, "MARKET", "paper-market", "USDC");
      await client.query(
        `INSERT INTO ledger_entries (event_id, account_id, amount)
         VALUES ($1, $2, -$5::numeric), ($1, $3, $5),
                ($1, $4, -$6::numeric), ($1, $7, $6)`,
        [eventId, fundAsset, marketAsset, marketUsdc, sale.quantity, sale.proceeds, fundUsdc],
      );
    }
    const shareAsset = `SHARE:${fundId}`;
    const userShares = await ledgerAccountId(client, "USER", actor.id, shareAsset);
    const issuance = await ledgerAccountId(client, "ISSUANCE", fundId, shareAsset);
    await client.query(
      `INSERT INTO ledger_entries (event_id, account_id, amount)
       VALUES ($1, $2, -$5::numeric), ($1, $3, $5),
              ($1, $4, -$6::numeric), ($1, $7, $6)`,
      [eventId, fundUsdc, userUsdc, userShares, fixed(payout, USDC_DECIMALS), sharesText, issuance],
    );
    await client.query(
      `UPDATE fund_shares SET shares = shares - $3::numeric WHERE fund_id = $1 AND user_id = $2`,
      [fundId, actor.id, sharesText],
    );
    await client.query("UPDATE users SET paper_cash = paper_cash + $2::numeric WHERE id = $1", [actor.id, fixed(payout, USDC_DECIMALS)]);
    await client.query(
      `UPDATE funds SET cash_usdc = cash_usdc - $2::numeric,
       total_shares = total_shares - $3::numeric WHERE id = $1`,
      [fundId, fixed(cashPart, USDC_DECIMALS), sharesText],
    );
    const newNav = valuation.nav.minus(cashPart).minus(markedAssetsRemoved);
    await saveNav(client, fundId, newNav, newSupply, valuation.pricedAt);
    const response: CrewChange = {
      mode: "PAPER", fundId, eventId, shares: sharesText,
      virtualUsdc: fixed(payout, USDC_DECIMALS), sharePrice: fixed(newNav.div(newSupply), SHARE_DECIMALS),
    };
    await finishIdempotent(client, actor.id, key, response, 200);
    return response;
  });
}

export async function myPositions(pool: DbPool, userId: string) {
  const result = await pool.query<{
    fund_id: string; name: string; shares: string; share_price_usdc: string | null;
    valuation_status: string | null; priced_at: Date | null; has_positions: boolean;
  }>(
    `SELECT s.fund_id, f.name, s.shares::text, n.share_price_usdc::text,
            n.status AS valuation_status, n.priced_at,
            EXISTS (SELECT 1 FROM positions p WHERE p.fund_id = s.fund_id AND p.quantity > 0) AS has_positions
     FROM fund_shares s JOIN funds f ON f.id = s.fund_id
     LEFT JOIN LATERAL (
       SELECT share_price_usdc, status, priced_at FROM nav_snapshots
       WHERE fund_id = s.fund_id ORDER BY event_sequence DESC NULLS LAST, created_at DESC LIMIT 1
     ) n ON true
     WHERE s.user_id = $1 AND s.shares > 0 ORDER BY f.created_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({
    fundId: row.fund_id, name: row.name, shares: row.shares,
    estimatedValueUsdc: row.share_price_usdc
      ? fixed(new Amount(row.shares).mul(row.share_price_usdc), USDC_DECIMALS) : null,
    valuationStatus: row.has_positions && (!row.priced_at || Date.now() - row.priced_at.getTime() > MAX_PRICE_AGE_MS)
      ? "UNAVAILABLE" : row.valuation_status ?? "UNAVAILABLE",
    pricedAt: row.priced_at?.toISOString() ?? null,
  }));
}
