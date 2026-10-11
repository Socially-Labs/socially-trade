import { appendFundEvent, inTransaction, cancelFundOrders, ledgerAccountId, saveFundNav, type DbPool } from "@socially/db";
import { Amount, paperPolicy, fixed, SHARE_DECIMALS, USDC_DECIMALS } from "@socially/domain";
import { assessFundFee } from "./fees.js";
import { lockValuedFund } from "./valuation.js";
import { eligibleFundBatches } from "./fund-batches.js";

/** Settle all virtual shares once, preserving the final valuation as a public record. */
export async function completeTrial(pool: DbPool, fundId: string, now = new Date()): Promise<boolean> {
  return inTransaction(pool, async client => {
    const valuation = await lockValuedFund(client, fundId);
    if (!valuation || valuation.fund.round_model_version !== 1 || valuation.fund.ends_at > now) return false;
    const { fund, positions, pricedAt } = valuation;
    await cancelFundOrders(client,fundId,'fund_not_tradable');
    let cash = new Amount(fund.cash_usdc);
    let liquidationCost = new Amount(0);
    if (positions.length) {
      const sales = positions.map(position => {
        const marked = new Amount(position.quantity).mul(position.price_usdc!);
        const proceeds = new Amount(fixed(marked.mul(new Amount(1).minus(new Amount(paperPolicy.unwindCostBps).div(10000))), USDC_DECIMALS));
        cash = cash.plus(proceeds);
        liquidationCost = liquidationCost.plus(marked.minus(proceeds));
        return { instrumentId: position.instrument_id, quantity: position.quantity,
          proceedsUsdc: fixed(proceeds, USDC_DECIMALS), observationId: position.observation_id };
      });
      const eventId = await appendFundEvent(client, fundId, "trial_liquidated", {
        sales, liquidationCostUsdc: fixed(liquidationCost, USDC_DECIMALS), modelVersion: 1,
      });
      const fundUsdc = await ledgerAccountId(client, "FUND", fundId, "USDC");
      const marketUsdc = await ledgerAccountId(client, "MARKET", "paper-market", "USDC");
      for (const sale of sales) {
        const fundAsset = await ledgerAccountId(client, "FUND", fundId, sale.instrumentId);
        const marketAsset = await ledgerAccountId(client, "MARKET", "paper-market", sale.instrumentId);
        await client.query(
          `INSERT INTO ledger_entries(event_id,account_id,amount)
           VALUES($1,$2,-$4::numeric),($1,$3,$4)`,
          [eventId, fundAsset, marketAsset, sale.quantity],
        );
        if (new Amount(sale.proceedsUsdc).gt(0)) {
          await client.query(
            `INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,$4),($1,$3,-$4::numeric)`,
            [eventId, fundUsdc, marketUsdc, sale.proceedsUsdc],
          );
        }
      }
      await client.query("UPDATE positions SET quantity=0,cost_basis_usdc=0 WHERE fund_id=$1", [fundId]);
      await client.query("UPDATE funds SET cash_usdc=$2 WHERE id=$1", [fundId, fixed(cash, USDC_DECIMALS)]);
      await saveFundNav(client, { fundId, navUsdc: fixed(cash, SHARE_DECIMALS),
        sharePriceUsdc: fixed(cash.div(fund.total_shares), SHARE_DECIMALS), pricedAt });
    }
    await assessFundFee(client, fundId, now.toISOString().slice(0, 10));
    const current = (await client.query<{ total_shares: string; protocol_shares: string; performance_fee_factor: string }>(
      "SELECT total_shares::text,protocol_shares::text,performance_fee_factor::text FROM funds WHERE id=$1", [fundId],
    )).rows[0]!;
    const holders = (await client.query<{ user_id: string; shares: string }>(
      "SELECT user_id,shares::text FROM fund_shares WHERE fund_id=$1 AND shares>0 ORDER BY user_id", [fundId],
    )).rows;
    // Every fund operation locks the fund first; settlements then lock holders in ID order.
    await client.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE", [holders.map(x => x.user_id)]);
    const finalPrice = cash.div(current.total_shares);
    const payouts = holders.map(holder => ({ userId: holder.user_id, shares: holder.shares,
      payoutUsdc: fixed(new Amount(holder.shares).mul(finalPrice), USDC_DECIMALS) }));
    const paid = payouts.reduce((sum, item) => sum.plus(item.payoutUsdc), new Amount(0));
    // Protocol receives its redemption plus sub-micro-USDC payout dust so cash reconciles exactly.
    const protocolPayout = cash.minus(paid);
    const eventId = await appendFundEvent(client, fundId, "trial_completed", {
      finalNavUsdc: fixed(cash, SHARE_DECIMALS), finalSharePriceUsdc: fixed(finalPrice, SHARE_DECIMALS),
      performanceFeeFactor: current.performance_fee_factor, payouts,
      protocolPayoutUsdc: fixed(protocolPayout, USDC_DECIMALS),
      liquidationCostUsdc: fixed(liquidationCost, USDC_DECIMALS), completedAt: now.toISOString(),
    });
    const shareAsset = `SHARE:${fundId}`;
    const issuance = await ledgerAccountId(client, "ISSUANCE", fundId, shareAsset);
    const fundUsdc = await ledgerAccountId(client, "FUND", fundId, "USDC");
    for (const payout of payouts) {
      const userShares = await ledgerAccountId(client, "USER", payout.userId, shareAsset);
      await client.query(
        "INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)",
        [eventId, userShares, issuance, payout.shares],
      );
      if (new Amount(payout.payoutUsdc).gt(0)) {
        const userUsdc = await ledgerAccountId(client, "USER", payout.userId, "USDC");
        await client.query(
          "INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)",
          [eventId, fundUsdc, userUsdc, payout.payoutUsdc],
        );
        await client.query("UPDATE users SET paper_cash=paper_cash+$2::numeric WHERE id=$1", [payout.userId, payout.payoutUsdc]);
      }
    }
    if (new Amount(current.protocol_shares).gt(0)) {
      const protocolShares = await ledgerAccountId(client, "PROTOCOL", "paper-protocol", shareAsset);
      await client.query(
        "INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)",
        [eventId, protocolShares, issuance, current.protocol_shares],
      );
    }
    if (protocolPayout.gt(0)) {
      const protocolUsdc = await ledgerAccountId(client, "PROTOCOL", "paper-protocol", "USDC");
      await client.query(
        "INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)",
        [eventId, fundUsdc, protocolUsdc, fixed(protocolPayout, USDC_DECIMALS)],
      );
    }
    await saveFundNav(client, { fundId, navUsdc: fixed(cash, SHARE_DECIMALS),
      sharePriceUsdc: fixed(finalPrice, SHARE_DECIMALS), pricedAt });
    await client.query("UPDATE fund_shares SET shares=0 WHERE fund_id=$1", [fundId]);
    await client.query(
      `UPDATE funds SET status='COMPLETED',cash_usdc=0,total_shares=0,protocol_shares=0,
       final_nav_usdc=$2,final_share_price_usdc=$3 WHERE id=$1`,
      [fundId, fixed(cash, SHARE_DECIMALS), fixed(finalPrice, SHARE_DECIMALS)],
    );
    await client.query("UPDATE trials SET status='COMPLETED' WHERE fund_id=$1", [fundId]);
    return true;
  });
}

export async function completeExpiredTrials(pool: DbPool, now = new Date()): Promise<number> {
  let completed = 0;
  for await (const batch of eligibleFundBatches(pool, { kind: "EXPIRED", now })) {
    for (const candidate of batch) if (await completeTrial(pool, candidate.id, now)) completed++;
  }
  return completed;
}
