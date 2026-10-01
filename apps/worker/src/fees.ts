import { randomUUID } from "node:crypto";
import { appendFundEvent, inTransaction, ledgerAccountId, saveFundNav, type DbClient, type DbPool } from "@socially/db";
import { Amount, calculatePerformanceFee, fixed, SHARE_DECIMALS } from "@socially/domain";
import { lockValuedFund } from "./valuation.js";

export async function assessFundFee(client: DbClient, fundId: string, feeDay: string): Promise<boolean> {
  const valuation = await lockValuedFund(client, fundId);
  if (!valuation || valuation.nav.lte(0)) return false;
  const { fund, nav, pricedAt, positions } = valuation;
  const prior = await client.query("SELECT 1 FROM fee_assessments WHERE fund_id=$1 AND fee_day=$2", [fundId, feeDay]);
  if (prior.rowCount) return false;
  const fee = calculatePerformanceFee(nav.toString(), fund.total_shares, fund.high_water_mark);
  if (new Amount(fee.sharesMinted).lte(0)) return false;
  const factor = fixed(new Amount(fund.performance_fee_factor).mul(fee.dilutionFactor), SHARE_DECIMALS);
  await client.query(
    `UPDATE funds SET total_shares=total_shares+$2::numeric,protocol_shares=protocol_shares+$3::numeric,
      high_water_mark=$4,performance_fee_factor=$5 WHERE id=$1`,
    [fundId, fee.sharesMinted, fee.protocolShares, fee.highWaterMarkAfter, factor],
  );
  await client.query(
    `INSERT INTO fund_shares(fund_id,user_id,shares) VALUES($1,$2,$3)
     ON CONFLICT(fund_id,user_id) DO UPDATE SET shares=fund_shares.shares+EXCLUDED.shares`,
    [fundId, fund.captain_id, fee.captainShares],
  );
  const eventId = await appendFundEvent(client, fundId, "fee_assessed", {
    ...fee, feeDay, captainId: fund.captain_id, highWaterMarkBefore: fund.high_water_mark,
    performanceFeeFactor: factor, navUsdc: fixed(nav, SHARE_DECIMALS),
  });
  const asset = `SHARE:${fundId}`;
  const issuance = await ledgerAccountId(client, "ISSUANCE", fundId, asset);
  const captain = await ledgerAccountId(client, "USER", fund.captain_id, asset);
  const protocol = await ledgerAccountId(client, "PROTOCOL", "paper-protocol", asset);
  await client.query(
    `INSERT INTO ledger_entries(event_id,account_id,amount)
     SELECT $1, account_id, amount FROM
       (VALUES($2::uuid,-$5::numeric),($3::uuid,$6::numeric),($4::uuid,$7::numeric)) entries(account_id,amount)
     WHERE amount<>0`,
    [eventId, issuance, captain, protocol, fee.sharesMinted, fee.captainShares, fee.protocolShares],
  );
  await client.query(
    `INSERT INTO fee_assessments(id,fund_id,fee_day,fee_usdc,shares_minted,event_id,model_version,
       pre_fee_share_price,post_fee_share_price,high_water_mark_before,captain_shares,protocol_shares)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), fundId, feeDay, fee.feeUsdc, fee.sharesMinted, eventId, fee.modelVersion,
      fee.preFeeSharePrice, fee.postFeeSharePrice, fund.high_water_mark, fee.captainShares, fee.protocolShares],
  );
  await saveFundNav(client, { fundId, navUsdc: fixed(nav, SHARE_DECIMALS),
    sharePriceUsdc: fee.postFeeSharePrice, pricedAt,
    observationId: positions.length === 1 ? positions[0]!.observation_id ?? undefined : undefined });
  return true;
}

export async function assessDailyFees(pool: DbPool, now = new Date()): Promise<number> {
  const feeDay = now.toISOString().slice(0, 10);
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM funds WHERE status IN ('ACTIVE','FROZEN')
     AND NOT EXISTS(SELECT 1 FROM fee_assessments a WHERE a.fund_id=funds.id AND a.fee_day=$1) LIMIT 100`, [feeDay],
  );
  let assessed = 0;
  for (const candidate of candidates.rows) {
    if (await inTransaction(pool, client => assessFundFee(client, candidate.id, feeDay))) assessed++;
  }
  return assessed;
}
