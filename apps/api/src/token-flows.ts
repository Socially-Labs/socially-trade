import { randomUUID } from "node:crypto";
import { inTransaction, ledgerAccountId, type DbClient, type DbPool } from "@socially/db";
import { Amount, parsePositiveAmount, SHARE_DECIMALS, USDC_DECIMALS } from "@socially/domain";
import { beginIdempotent, finishIdempotent } from "./accounting.js";
import type { Actor } from "./auth.js";
import { joinFundInTransaction, leaveFundInTransaction, myPositions, type CrewChange } from "./crew.js";
import { ApiFault } from "./errors.js";
import { privySolanaWallets } from "./privy.js";
import {
  fromRaw, toRaw, TOKEN_DECIMALS, TOKEN_LABEL,
  type ObservedTransaction, type SignedTransfer, type TokenChain,
} from "./token-chain.js";

// The paper ledger counterparty for value that entered or left through the devnet treasury.
const TREASURY_LEDGER = ["ISSUANCE", "devnet-usdg"] as const;
const POLL_MS = 500;
const payoutWaitMs = () => Number(process.env.PAYOUT_CONFIRM_WAIT_MS ?? 20_000);
const depositExpiryMs = () => Number(process.env.DEPOSIT_EXPIRY_SECONDS ?? 300) * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- wallets ----------

export async function walletOf(db: DbPool | DbClient, userId: string): Promise<string | null> {
  const result = await db.query<{ address: string }>("SELECT address FROM user_wallets WHERE user_id = $1", [userId]);
  return result.rows[0]?.address ?? null;
}

/**
 * Binds one Solana wallet to the user, once. With PRIVY_APP_SECRET the wallet must be linked
 * to the Privy user; without it (development only) the client-supplied address is accepted.
 */
export async function bindWallet(pool: DbPool, actor: Actor, requested: string | undefined): Promise<string | null> {
  const existing = await walletOf(pool, actor.id);
  if (existing && (!requested || requested === existing)) return existing;
  if (existing) throw new ApiFault(409, "wallet_mismatch", "A different wallet is already bound to this account");
  const linked = await privySolanaWallets(actor.subject);
  let candidate: string | undefined;
  if (linked) {
    if (requested && !linked.includes(requested)) {
      throw new ApiFault(403, "wallet_not_linked", "walletAddress is not linked to this Privy user");
    }
    candidate = requested ?? linked[0];
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new ApiFault(503, "wallet_verification_unconfigured", "PRIVY_APP_SECRET is required to bind wallets");
    }
    candidate = requested;
  }
  if (!candidate) return null;
  try {
    await pool.query(
      "INSERT INTO user_wallets (user_id, address) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [actor.id, candidate],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ApiFault(409, "wallet_in_use", "This wallet is bound to another account");
    }
    throw error;
  }
  const bound = await walletOf(pool, actor.id);
  if (bound !== candidate) throw new ApiFault(409, "wallet_mismatch", "A different wallet is already bound to this account");
  return bound;
}

async function requireWallet(db: DbPool | DbClient, userId: string): Promise<string> {
  const wallet = await walletOf(db, userId);
  if (!wallet) throw new ApiFault(409, "wallet_required", "Bind a Solana wallet with POST /v0/auth/privy first");
  return wallet;
}

// ---------- payouts: signup grant and withdrawals ----------

interface PayoutRow {
  id: string;
  kind: "SIGNUP_GRANT" | "WITHDRAWAL";
  wallet: string;
  amount_raw: string;
  status: "PENDING" | "CONFIRMED";
  signature: string | null;
  wire_transaction: string | null;
  last_valid_block_height: string | null;
  attempts: number;
  last_error: string | null;
}

export interface PayoutView {
  id: string;
  kind: PayoutRow["kind"];
  status: PayoutRow["status"];
  signature: string | null;
  amount: string;
  wallet: string;
  attempts: number;
  lastError: string | null;
}

const payoutColumns = `id, kind, wallet, amount_raw::text, status, signature, wire_transaction,
  last_valid_block_height::text, attempts, last_error`;

function payoutView(row: PayoutRow): PayoutView {
  return {
    id: row.id, kind: row.kind, status: row.status, signature: row.signature,
    amount: fromRaw(row.amount_raw), wallet: row.wallet, attempts: row.attempts, lastError: row.last_error,
  };
}

/**
 * One locked step of the payout state machine. It never signs a second transfer while an
 * earlier signature can still land: a new signature needs the old one failed, or missing
 * after its blockhash expired. The signed bytes are saved before anything is sent.
 */
async function advancePayout(pool: DbPool, chain: TokenChain, id: string): Promise<{ row: PayoutRow; broadcast: string | null }> {
  return inTransaction(pool, async (client) => {
    const row = (await client.query<PayoutRow>(`SELECT ${payoutColumns} FROM token_payouts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new ApiFault(404, "payout_not_found", "Payout not found");
    if (row.status === "CONFIRMED") return { row, broadcast: null };
    let reason: string | null = null;
    if (row.signature) {
      // Read the height first: a missing transaction past this height can never land later.
      const height = await chain.blockHeight();
      const state = await chain.status(row.signature);
      if (state === "confirmed") {
        const done = await client.query<PayoutRow>(
          `UPDATE token_payouts SET status = 'CONFIRMED', last_error = NULL, updated_at = now()
           WHERE id = $1 RETURNING ${payoutColumns}`, [id]);
        return { row: done.rows[0]!, broadcast: null };
      }
      if (state === "processing") return { row, broadcast: null };
      if (state === "missing" && height <= BigInt(row.last_valid_block_height!)) {
        return { row, broadcast: row.wire_transaction };
      }
      reason = state === "failed" ? "transaction_failed" : "blockhash_expired";
    }
    const signed: SignedTransfer = row.kind === "SIGNUP_GRANT"
      ? await chain.signMint(row.wallet, BigInt(row.amount_raw))
      : await chain.signPayout(row.wallet, BigInt(row.amount_raw));
    const next = await client.query<PayoutRow>(
      `UPDATE token_payouts SET signature = $2, wire_transaction = $3, last_valid_block_height = $4,
         attempts = attempts + 1, last_error = $5, updated_at = now()
       WHERE id = $1 RETURNING ${payoutColumns}`,
      [id, signed.signature, signed.wire, signed.lastValidBlockHeight.toString(), reason],
    );
    return { row: next.rows[0]!, broadcast: signed.wire };
  });
}

async function broadcast(pool: DbPool, chain: TokenChain, row: PayoutRow, wire: string): Promise<void> {
  try { await chain.send(wire); }
  catch (error) {
    // The saved signature stays. The next advance rebroadcasts it or, after expiry, signs again.
    const message = error instanceof Error ? error.message.slice(0, 300) : "send_failed";
    await pool.query("UPDATE token_payouts SET last_error = $2, updated_at = now() WHERE id = $1 AND signature = $3",
      [row.id, message, row.signature]);
  }
}

/** Drives a payout towards CONFIRMED. With waitMs = 0 it reconciles once and returns. */
export async function settlePayout(pool: DbPool, chain: TokenChain, id: string, waitMs = payoutWaitMs()): Promise<PayoutView> {
  const deadline = Date.now() + waitMs;
  let { row, broadcast: wire } = await advancePayout(pool, chain, id);
  if (!wire) return payoutView(row);
  await broadcast(pool, chain, row, wire);
  while (Date.now() < deadline) {
    const state = await chain.status(row.signature!);
    if (state === "confirmed" || state === "failed") break;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  if (waitMs <= 0) return payoutView(row);
  ({ row, broadcast: wire } = await advancePayout(pool, chain, id));
  if (wire) await broadcast(pool, chain, row, wire);
  return payoutView(row);
}

export async function ensureSignupGrant(pool: DbPool, chain: TokenChain, actor: Actor, wallet: string, amountRaw: bigint) {
  await pool.query(
    `INSERT INTO token_payouts (id, kind, user_id, wallet, amount_raw) VALUES ($1, 'SIGNUP_GRANT', $2, $3, $4)
     ON CONFLICT (user_id) WHERE kind = 'SIGNUP_GRANT' DO NOTHING`,
    [randomUUID(), actor.id, wallet, amountRaw.toString()],
  );
  const id = (await pool.query<{ id: string }>(
    "SELECT id FROM token_payouts WHERE user_id = $1 AND kind = 'SIGNUP_GRANT'", [actor.id])).rows[0]!.id;
  return settlePayout(pool, chain, id);
}

export async function reconcilePayouts(pool: DbPool, chain: TokenChain, userId: string): Promise<void> {
  const pending = await pool.query<{ id: string }>(
    "SELECT id FROM token_payouts WHERE user_id = $1 AND status = 'PENDING' ORDER BY created_at", [userId]);
  for (const { id } of pending.rows) await settlePayout(pool, chain, id, 0);
}

interface WithdrawalRequest { amountUsdc?: string; fundId?: string; shares?: string }
interface WithdrawalRecord { withdrawalId: string; amountUsdc: string; exit: CrewChange | null }

async function moveTreasuryLedger(client: DbClient, userId: string, type: string, payload: object, userDelta: string) {
  const eventId = randomUUID();
  await client.query("INSERT INTO fund_events (id, type, payload) VALUES ($1, $2, $3)", [eventId, type, payload]);
  const user = await ledgerAccountId(client, "USER", userId, "USDC");
  const treasury = await ledgerAccountId(client, ...TREASURY_LEDGER, "USDC");
  await client.query(
    `INSERT INTO ledger_entries (event_id, account_id, amount) VALUES ($1, $2, $3::numeric), ($1, $4, -$3::numeric)`,
    [eventId, user, userDelta, treasury],
  );
  return eventId;
}

/**
 * Debits the paper ledger and records the payout intent in one transaction, then sends.
 * The Idempotency-Key maps every retry to the same withdrawal id, so one request sends once.
 */
export async function requestWithdrawal(
  pool: DbPool, chain: TokenChain, actor: Actor, key: string, body: WithdrawalRequest,
): Promise<{ withdrawal: PayoutView; exit: CrewChange | null }> {
  const viaExit = body.fundId !== undefined || body.shares !== undefined;
  if (viaExit === (body.amountUsdc !== undefined) || (viaExit && (!body.fundId || !body.shares))) {
    throw new ApiFault(400, "invalid_withdrawal", "Send either amountUsdc, or fundId with shares");
  }
  let amount: Amount | undefined;
  let shares: Amount | undefined;
  try {
    if (viaExit) shares = parsePositiveAmount(body.shares, SHARE_DECIMALS);
    else amount = parsePositiveAmount(body.amountUsdc, USDC_DECIMALS);
  } catch { throw new ApiFault(400, "invalid_amount", "Amounts must be positive decimal strings within token precision"); }
  const record = await inTransaction(pool, async (client) => {
    const prior = await beginIdempotent<WithdrawalRecord>(client, actor.id, key, "POST /v0/me/withdrawals", body);
    if (prior) return prior;
    const wallet = await requireWallet(client, actor.id);
    const exit = viaExit ? await leaveFundInTransaction(client, actor, body.fundId!, shares!) : null;
    const amountUsdc = exit ? exit.virtualUsdc : amount!.toFixed(USDC_DECIMALS);
    const user = await client.query<{ paper_cash: string }>(
      "SELECT paper_cash::text FROM users WHERE id = $1 FOR NO KEY UPDATE", [actor.id]);
    if (new Amount(user.rows[0]!.paper_cash).lt(amountUsdc)) {
      throw new ApiFault(422, "insufficient_virtual_cash", "Not enough paper USDC to withdraw");
    }
    const id = randomUUID();
    await client.query("UPDATE users SET paper_cash = paper_cash - $2::numeric WHERE id = $1", [actor.id, amountUsdc]);
    const eventId = await moveTreasuryLedger(client, actor.id, "devnet_withdrawal_requested",
      { userId: actor.id, withdrawalId: id, amount: amountUsdc, asset: "USDC", wallet }, `-${amountUsdc}`);
    await client.query(
      `INSERT INTO token_payouts (id, kind, user_id, wallet, amount_raw, event_id) VALUES ($1, 'WITHDRAWAL', $2, $3, $4, $5)`,
      [id, actor.id, wallet, toRaw(amountUsdc).toString(), eventId],
    );
    const response: WithdrawalRecord = { withdrawalId: id, amountUsdc, exit };
    await finishIdempotent(client, actor.id, key, response, 201);
    return response;
  });
  return { withdrawal: await settlePayout(pool, chain, record.withdrawalId), exit: record.exit };
}

export async function withdrawalStatus(pool: DbPool, chain: TokenChain, actor: Actor, id: string): Promise<PayoutView> {
  const owned = await pool.query("SELECT 1 FROM token_payouts WHERE id = $1 AND user_id = $2", [id, actor.id]);
  if (!owned.rowCount) throw new ApiFault(404, "payout_not_found", "Payout not found");
  return settlePayout(pool, chain, id, 0);
}

// ---------- deposits: user-signed transfers into the treasury ----------

export type DepositFailure = "transaction_failed" | "wrong_mint" | "wrong_destination" | "wrong_owner" | "wrong_amount";

/** Binds a confirmed transaction to one paper action: our mint, exact amount, the user's wallet, our treasury. */
export function depositFailure(
  tx: ObservedTransaction,
  expected: { mint: string; treasuryAta: string; wallet: string; amountRaw: bigint },
): DepositFailure | null {
  if (tx.failed) return "transaction_failed";
  const ours = tx.balances.filter((b) => b.mint === expected.mint);
  if (!ours.some((b) => b.post !== b.pre)) return "wrong_mint";
  const treasury = ours.find((b) => b.account === expected.treasuryAta);
  const received = treasury ? treasury.post - treasury.pre : 0n;
  if (received <= 0n) return "wrong_destination";
  const sources = ours.filter((b) => b.owner === expected.wallet && b.post < b.pre);
  if (sources.length === 0) return "wrong_owner";
  const sent = sources.reduce((sum, b) => sum + b.pre - b.post, 0n);
  if (received !== expected.amountRaw || sent !== expected.amountRaw) return "wrong_amount";
  return null;
}

interface DepositRow {
  id: string;
  signature: string;
  amount_raw: string;
  fund_id: string | null;
  status: "PENDING" | "CONFIRMED" | "FAILED" | "EXPIRED";
  failure: string | null;
  event_id: string | null;
  join_event_id: string | null;
  join_error: string | null;
  created_at: Date;
}

export interface DepositView {
  signature: string;
  status: DepositRow["status"];
  amount: string;
  fundId: string | null;
  failure: string | null;
  eventId: string | null;
  join: { eventId: string | null; error: string | null } | null;
}

function depositView(row: DepositRow): DepositView {
  return {
    signature: row.signature, status: row.status, amount: fromRaw(row.amount_raw), fundId: row.fund_id,
    failure: row.failure, eventId: row.event_id,
    join: row.fund_id ? { eventId: row.join_event_id, error: row.join_error } : null,
  };
}

const depositColumns = `id, signature, amount_raw::text, fund_id, status, failure, event_id, join_event_id, join_error, created_at`;

export async function claimDeposit(
  pool: DbPool, chain: TokenChain, actor: Actor,
  input: { signature: string; amountUsdc: string; fundId?: string },
): Promise<DepositView> {
  let amountRaw: bigint;
  try { amountRaw = toRaw(input.amountUsdc); }
  catch { throw new ApiFault(400, "invalid_amount", "amountUsdc must be a decimal string with at most 6 places"); }
  if (amountRaw < 10n ** BigInt(TOKEN_DECIMALS)) throw new ApiFault(400, "amount_too_small", "Minimum deposit is 1 token");
  await requireWallet(pool, actor.id);
  if (input.fundId) {
    const fund = await pool.query("SELECT 1 FROM funds WHERE id = $1", [input.fundId]);
    if (!fund.rowCount) throw new ApiFault(404, "fund_not_found", "Fund not found");
  }
  await pool.query(
    `INSERT INTO token_deposits (id, signature, user_id, amount_raw, fund_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (signature, user_id) DO NOTHING`,
    [randomUUID(), input.signature, actor.id, amountRaw.toString(), input.fundId ?? null],
  );
  return verifyDeposit(pool, chain, actor, input.signature, { amountRaw, fundId: input.fundId ?? null });
}

/**
 * Verifies a pending claim under its row lock, so parallel confirms of one signature credit once.
 * Terminal states never change again.
 */
export async function verifyDeposit(
  pool: DbPool, chain: TokenChain, actor: Actor, signature: string,
  expected: { amountRaw: bigint; fundId: string | null } | null,
): Promise<DepositView> {
  return inTransaction(pool, async (client) => {
    const row = (await client.query<DepositRow>(
      `SELECT ${depositColumns} FROM token_deposits WHERE signature = $1 AND user_id = $2 FOR UPDATE`,
      [signature, actor.id])).rows[0];
    if (!row) throw new ApiFault(404, "deposit_not_found", "Deposit not found");
    if (expected && (BigInt(row.amount_raw) !== expected.amountRaw || row.fund_id !== expected.fundId)) {
      throw new ApiFault(409, "deposit_conflict", "This signature was already submitted with another amount or fund");
    }
    if (row.status !== "PENDING") return depositView(row);
    const finish = async (sql: string, params: unknown[]) => depositView((await client.query<DepositRow>(
      `UPDATE token_deposits SET ${sql}, updated_at = now() WHERE id = $1 RETURNING ${depositColumns}`,
      [row.id, ...params])).rows[0]!);

    const tx = await chain.observe(signature);
    if (!tx) {
      if (Date.now() - row.created_at.getTime() > depositExpiryMs()) {
        return finish("status = 'EXPIRED', failure = 'not_found_before_expiry'", []);
      }
      return depositView(row);
    }
    const wallet = (await walletOf(client, actor.id))!;
    const failure = depositFailure(tx, { mint: chain.mint, treasuryAta: chain.treasuryAta, wallet, amountRaw: BigInt(row.amount_raw) });
    if (failure) return finish("status = 'FAILED', failure = $2", [failure]);

    const amountUsdc = fromRaw(row.amount_raw);
    await client.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [actor.id]);
    await client.query("UPDATE users SET paper_cash = paper_cash + $2::numeric WHERE id = $1", [actor.id, amountUsdc]);
    const eventId = await moveTreasuryLedger(client, actor.id, "devnet_deposit_confirmed",
      { userId: actor.id, signature, amount: amountUsdc, asset: "USDC", wallet }, amountUsdc);
    let joinEventId: string | null = null;
    let joinError: string | null = null;
    if (row.fund_id) {
      // A failed join must not undo a confirmed on-chain payment: the credit stays as paper cash.
      await client.query("SAVEPOINT deposit_join");
      try {
        joinEventId = (await joinFundInTransaction(client, actor, row.fund_id, new Amount(amountUsdc))).eventId;
        await client.query("RELEASE SAVEPOINT deposit_join");
      } catch (error) {
        if (!(error instanceof ApiFault)) throw error;
        await client.query("ROLLBACK TO SAVEPOINT deposit_join");
        joinError = error.code;
      }
    }
    return finish("status = 'CONFIRMED', event_id = $2, join_event_id = $3, join_error = $4",
      [eventId, joinEventId, joinError]);
  });
}

export async function prepareDeposit(pool: DbPool, chain: TokenChain, actor: Actor, amountUsdc: string) {
  let amountRaw: bigint;
  try { amountRaw = toRaw(amountUsdc); }
  catch { throw new ApiFault(400, "invalid_amount", "amountUsdc must be a decimal string with at most 6 places"); }
  if (amountRaw < 10n ** BigInt(TOKEN_DECIMALS)) throw new ApiFault(400, "amount_too_small", "Minimum deposit is 1 token");
  const wallet = await requireWallet(pool, actor.id);
  const prepared = await chain.prepareDeposit(wallet, amountRaw);
  return {
    mode: "PAPER" as const, token: tokenInfo(chain), wallet, treasuryTokenAccount: chain.treasuryAta,
    amountUsdc: fromRaw(amountRaw), transaction: prepared.transaction, encoding: "base64",
    lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
  };
}

// ---------- balances ----------

export const tokenInfo = (chain: TokenChain) => ({ label: TOKEN_LABEL, mint: chain.mint, decimals: TOKEN_DECIMALS, cluster: "devnet" });

export async function tokenBalances(pool: DbPool, chain: TokenChain, actor: Actor) {
  await reconcilePayouts(pool, chain, actor.id);
  const wallet = await walletOf(pool, actor.id);
  const raw = wallet ? await chain.balance(wallet) : null;
  const cash = await pool.query<{ paper_cash: string }>("SELECT paper_cash::text FROM users WHERE id = $1", [actor.id]);
  return {
    mode: "PAPER" as const,
    token: tokenInfo(chain),
    wallet,
    onchain: raw === null ? null : { amount: fromRaw(raw), raw: raw.toString() },
    paper: { cash: { value: cash.rows[0]!.paper_cash, asset: "USDC" }, positions: await myPositions(pool, actor.id) },
  };
}
