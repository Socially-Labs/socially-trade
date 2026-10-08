import { advanceDueVaultRounds } from "./vault-rounds.js";
import type { DbPool } from "@socially/db";
import { markActiveFunds, processPendingOrders } from "./orders.js";
import { deliverOutbox } from "./notifications.js";
import { assessDailyFees } from "./fees.js";
import { completeExpiredTrials } from "./trials.js";

/** Price outages must not block order timeouts or committed notification delivery. */
export async function runWorkerCycle(pool: DbPool, ingestPrice?: () => Promise<unknown>) {
  const failures: Array<{ job: string; error: unknown }> = [];
  let marked = 0;
  let processed = 0;
  let delivered = 0;
  let feesAssessed = 0;
  let trialsCompleted = 0;
  let roundsAdvanced = 0;
  try { roundsAdvanced = await advanceDueVaultRounds(pool); }
  catch (error) { failures.push({ job: "vault_rounds", error }); }
  if (ingestPrice) {
    try { await ingestPrice(); }
    catch (error) { failures.push({ job: "price_ingestion", error }); }
  }
  try { marked = await markActiveFunds(pool); }
  catch (error) { failures.push({ job: "fund_valuation", error }); }
  try { processed = await processPendingOrders(pool); }
  catch (error) { failures.push({ job: "order_processing", error }); }
  try { trialsCompleted = await completeExpiredTrials(pool); }
  catch (error) { failures.push({ job: "trial_completion", error }); }
  try { feesAssessed = await assessDailyFees(pool); }
  catch (error) { failures.push({ job: "performance_fees", error }); }
  try { delivered = await deliverOutbox(pool); }
  catch (error) { failures.push({ job: "notification_delivery", error }); }
  return { roundsAdvanced, marked, processed, delivered, feesAssessed, trialsCompleted, failures };
}
