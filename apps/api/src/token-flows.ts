import { randomUUID } from "node:crypto";
import { inTransaction, ledgerAccountId, type DbClient, type DbPool } from "@socially/db";
import { Amount, parsePositiveAmount, SHARE_DECIMALS, USDC_DECIMALS } from "@socially/domain";
import { beginIdempotent, finishIdempotent } from "./accounting.js";
import type { Actor } from "./auth.js";
import { joinFundInTransaction, leaveFundInTransaction, myPositions, type CrewChange } from "./crew.js";
import { ApiFault } from "./errors.js";
import { privySolanaWallets } from "./privy.js";
import {
  COMPUTE_BUDGET_PROGRAM, fromRaw, toRaw, TOKEN_DECIMALS, TOKEN_LABEL, TOKEN_PROGRAM_ADDRESS,
  type ObservedTransaction, type SignedTransfer, type TokenChain,
} from "./token-chain.js";

/** The devnet token layer as the app runs it. */
export interface TokenLayer {
  chain: TokenChain;
  signupGrantRaw: bigint;
  /** Bind a client-supplied wallet without Privy (DEV_ALLOW_UNVERIFIED_WALLET=1, devnet only). */
  allowUnverifiedWallet?: boolean;
}

// The paper ledger counterparty for value that entered or left through the devnet treasury.
const TREASURY_LEDGER = ["ISSUANCE", "devnet-usdg"] as const;
const POLL_MS = 500;
const payoutWaitMs = () => Number(process.env.PAYOUT_CONFIRM_WAIT_MS ?? 20_000);
const depositExpiryMs = () => Number(process.env.DEPOSIT_EXPIRY_SECONDS ?? 300) * 1000;
// A blockhash is valid for 150 blocks. The other 150 cover an RPC node behind the cluster tip.
const DEPOSIT_EXPIRY_BLOCKS = 300n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The treasury pays the rent of a user's token account at most this many times, ever. */
export const MAX_TREASURY_ATA_CREATIONS = 3;
// Longer than the two RPC calls (token account read, blockhash) a signer makes, each capped at 10 s.
const SIGNING_LEASE_SECONDS = 30;

function limitFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/** Token-layer limits. Invalid values stop the server at startup (see index.ts) and never fail open. */
export const tokenLimits = () => {
  let withdrawMinRaw: bigint;
  try { withdrawMinRaw = toRaw(process.env.WITHDRAW_MIN ?? "1"); }
  catch { throw new Error("WITHDRAW_MIN must be a decimal string with at most 6 places"); }
  return {
    withdrawMinRaw,
    withdrawalsPerHour: limitFromEnv("WITHDRAW_RATE_PER_HOUR", 10),
    preparesPerHour: limitFromEnv("PREPARE_RATE_PER_HOUR", 20),
  };
};

const rateLimited = (what: string, limit: number) =>
  new ApiFault(429, "rate_limited", `At most ${limit} ${what} per hour. Try again later`);

// ---------- wallets ----------

export async function walletOf(db: DbPool | DbClient, userId: string): Promise<string | null> {
  const result = await db.query<{ address: string }>("SELECT address FROM user_wallets WHERE user_id = $1", [userId]);
  return result.rows[0]?.address ?? null;
}

/**
 * Binds one Solana wallet to the user, once. With PRIVY_APP_SECRET the wallet must be linked
 * to the Privy user. Without it the bind fails closed, unless the layer runs with
 * DEV_ALLOW_UNVERIFIED_WALLET=1 (devnet only), which accepts the client-supplied address.
 * The same transaction decides the user's one signup grant (see createSignupGrant).
 */
export async function bindWallet(pool: DbPool, layer: TokenLayer, actor: Actor, requested: string | undefined): Promise<string | null> {
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
    if (!layer.allowUnverifiedWallet) {
      throw new ApiFault(503, "wallet_verification_unconfigured", "PRIVY_APP_SECRET is required to bind wallets");
    }
    candidate = requested;
  }
  if (!candidate) return null;
  const wallet = candidate;
  try {
    return await inTransaction(pool, async (client) => {
      // The user row lock orders parallel binds and freezes paper cash for the conversion.
      const user = await client.query<{ paper_cash: string; convertible: string }>(
        "SELECT paper_cash::text, trunc(paper_cash, 6)::text AS convertible FROM users WHERE id = $1 FOR NO KEY UPDATE",
        [actor.id]);
      const inserted = await client.query(
        "INSERT INTO user_wallets (user_id, address) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING", [actor.id, wallet]);
      if (!inserted.rowCount) {
        const bound = await walletOf(client, actor.id);
        if (bound !== wallet) throw new ApiFault(409, "wallet_mismatch", "A different wallet is already bound to this account");
        return bound;
      }
      await createSignupGrant(client, actor.id, wallet, user.rows[0]!, layer.signupGrantRaw);
      return wallet;
    });
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "user_wallets_address_key") {
      throw new ApiFault(409, "wallet_in_use", "This wallet is bound to another account");
    }
    throw error;
  }
}

/**
 * Runs once per user, at wallet bind. A user with paper cash (an account from before the token
 * layer was on) converts that cash: the grant equals the cash and the cash becomes 0, so the
 * value moves to the chain and does not double. A user with no cash and no ledger history gets
 * SIGNUP_GRANT. A user with no cash but history gets nothing. The unique SIGNUP_GRANT row per
 * user keeps it to one grant or conversion ever, also when the layer is switched off and on.
 */
async function createSignupGrant(
  client: DbClient, userId: string, wallet: string, cash: { paper_cash: string; convertible: string }, signupGrantRaw: bigint,
): Promise<void> {
  // External deposits already back this trading balance with tokens in the treasury.
  // Linking a personal wallet later must not convert or mint that balance again.
  const funded = await client.query("SELECT 1 FROM token_deposit_receipts WHERE user_id=$1 LIMIT 1", [userId]);
  if (funded.rowCount) return;
  let amountRaw = toRaw(cash.convertible);
  let eventId: string | null = null;
  if (amountRaw > 0n) {
    eventId = await moveTreasuryLedger(client, userId, "devnet_paper_converted",
      { userId, amount: cash.paper_cash, minted: fromRaw(amountRaw), asset: "USDC", wallet }, `-${cash.paper_cash}`);
    await client.query("UPDATE users SET paper_cash = 0 WHERE id = $1", [userId]);
  } else {
    const history = await client.query(
      `SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE a.owner_type = 'USER' AND a.owner_id = $1 LIMIT 1`, [userId]);
    if (history.rowCount) return;
    amountRaw = signupGrantRaw;
  }
  await client.query(
    `INSERT INTO token_payouts (id, kind, user_id, wallet, amount_raw, event_id) VALUES ($1, 'SIGNUP_GRANT', $2, $3, $4, $5)
     ON CONFLICT (user_id) WHERE kind = 'SIGNUP_GRANT' DO NOTHING`,
    [randomUUID(), userId, wallet, amountRaw.toString(), eventId],
  );
}

async function requireWallet(db: DbPool | DbClient, userId: string): Promise<string> {
  const wallet = await walletOf(db, userId);
  if (!wallet) throw new ApiFault(409, "wallet_required", "Bind a Solana wallet with POST /v0/auth/privy first");
  return wallet;
}

// ---------- payouts: signup grant and withdrawals ----------

interface PayoutRow {
  id: string;
  user_id: string;
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

const payoutColumns = `id, user_id, kind, wallet, amount_raw::text, status, signature, wire_transaction,
  last_valid_block_height::text, attempts, last_error`;

function payoutView(row: PayoutRow): PayoutView {
  return {
    id: row.id, kind: row.kind, status: row.status, signature: row.signature,
    amount: fromRaw(row.amount_raw), wallet: row.wallet, attempts: row.attempts, lastError: row.last_error,
  };
}

async function readPayout(db: DbPool | DbClient, id: string): Promise<PayoutRow> {
  const row = (await db.query<PayoutRow>(`SELECT ${payoutColumns} FROM token_payouts WHERE id = $1`, [id])).rows[0];
  if (!row) throw new ApiFault(404, "payout_not_found", "Payout not found");
  return row;
}

/**
 * One step of the payout state machine. RPC calls run with no database transaction or row lock
 * open; each write is a compare-and-set on the signature this step read. It never signs a second
 * transfer while an earlier signature can still land: a new signature needs the old one failed,
 * or missing after its blockhash expired. The signed bytes are saved before anything is sent, and
 * a signature that loses the compare-and-set is dropped unsent.
 */
async function advancePayout(pool: DbPool, chain: TokenChain, id: string): Promise<{ row: PayoutRow; broadcast: string | null }> {
  const row = await readPayout(pool, id);
  if (row.status === "CONFIRMED") return { row, broadcast: null };
  let reason: string | null = null;
  if (row.signature) {
    // Read the height first: a missing transaction past this height can never land later.
    const height = await chain.blockHeight();
    const state = await chain.status(row.signature);
    if (state === "confirmed") {
      await pool.query(
        `UPDATE token_payouts SET status = 'CONFIRMED', last_error = NULL, updated_at = now()
         WHERE id = $1 AND signature = $2 AND status = 'PENDING'`, [id, row.signature]);
      return { row: await readPayout(pool, id), broadcast: null };
    }
    if (state === "processing") return { row, broadcast: null };
    if (state === "missing" && height <= BigInt(row.last_valid_block_height!)) {
      return { row, broadcast: row.wire_transaction };
    }
    reason = state === "failed" ? "transaction_failed" : "blockhash_expired";
  }
  // Claim the right to sign. Another caller that holds it is signing now; this one returns.
  const lease = await pool.query(
    `UPDATE token_payouts SET signing_until = now() + make_interval(secs => $3)
     WHERE id = $1 AND status = 'PENDING' AND signature IS NOT DISTINCT FROM $2
       AND (signing_until IS NULL OR signing_until < now())`,
    [id, row.signature, SIGNING_LEASE_SECONDS]);
  if (!lease.rowCount) return { row: await readPayout(pool, id), broadcast: null };
  let signed: SignedTransfer;
  let createAta: boolean;
  try {
    createAta = !(await chain.tokenAccountExists(row.wallet));
    signed = row.kind === "SIGNUP_GRANT"
      ? await chain.signMint(row.wallet, BigInt(row.amount_raw), createAta)
      : await chain.signPayout(row.wallet, BigInt(row.amount_raw), createAta);
  } catch (error) {
    await pool.query("UPDATE token_payouts SET signing_until = NULL WHERE id = $1", [id]);
    throw error;
  }
  const saved = await inTransaction(pool, async (client) => {
    const next = await client.query<PayoutRow>(
      `UPDATE token_payouts SET signature = $2, wire_transaction = $3, last_valid_block_height = $4,
         attempts = attempts + 1, last_error = $5, signing_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'PENDING' AND signature IS NOT DISTINCT FROM $6 RETURNING ${payoutColumns}`,
      [id, signed.signature, signed.wire, signed.lastValidBlockHeight.toString(), reason, row.signature],
    );
    if (!next.rows[0]) return null;
    // ponytail: a slot is spent per signed creation, so a creation that expires unsent also counts.
    // Fine at 3 slots on devnet; count at confirmation if users hit the limit through dropped sends.
    if (createAta) {
      const slot = await client.query(
        "UPDATE user_wallets SET ata_creations = ata_creations + 1 WHERE user_id = $1 AND ata_creations < $2",
        [row.user_id, MAX_TREASURY_ATA_CREATIONS]);
      if (!slot.rowCount) throw new ApiFault(409, "token_account_required", tokenAccountRequired);
    }
    return next.rows[0];
  }).catch(async (error: unknown) => {
    if (!(error instanceof ApiFault) || error.code !== "token_account_required") throw error;
    // The payout waits until the user creates the token account; the next reconcile signs again.
    await pool.query(
      `UPDATE token_payouts SET last_error = 'token_account_required', signing_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'PENDING' AND signature IS NOT DISTINCT FROM $2`, [id, row.signature]);
    return null;
  });
  if (!saved) return { row: await readPayout(pool, id), broadcast: null };
  return { row: saved, broadcast: signed.wire };
}

const tokenAccountRequired = "The treasury already paid for your USDG token account "
  + `${MAX_TREASURY_ATA_CREATIONS} times. Create the associated token account for this mint, then try again`;

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

/** Settles the user's grant or conversion, if bindWallet created one. */
export async function settleSignupGrant(pool: DbPool, chain: TokenChain, userId: string): Promise<PayoutView | null> {
  const grant = await pool.query<{ id: string }>(
    "SELECT id FROM token_payouts WHERE user_id = $1 AND kind = 'SIGNUP_GRANT'", [userId]);
  return grant.rows[0] ? settlePayout(pool, chain, grant.rows[0].id) : null;
}

export async function reconcilePayouts(pool: DbPool, chain: TokenChain, userId: string): Promise<void> {
  const pending = await pool.query<{ id: string }>(
    "SELECT id FROM token_payouts WHERE user_id = $1 AND status = 'PENDING' ORDER BY created_at", [userId]);
  for (const { id } of pending.rows) await settlePayout(pool, chain, id, 0);
}

interface WithdrawalRequest { amountUsdc?: string; fundId?: string; shares?: string }
interface WithdrawalRecord { withdrawalId: string; amountUsdc: string; exit: CrewChange | null }

export async function moveTreasuryLedger(client: DbClient, userId: string, type: string, payload: object, userDelta: string) {
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
  const limits = tokenLimits();
  // The chain read runs before the transaction opens. The result is used only after the
  // idempotency check, so a retry of an accepted request still returns its first result.
  const ataExists = await chain.tokenAccountExists(await requireWallet(pool, actor.id));
  const record = await inTransaction(pool, async (client) => {
    const prior = await beginIdempotent<WithdrawalRecord>(client, actor.id, key, "POST /v0/me/withdrawals", body);
    if (prior) return prior;
    const wallet = await requireWallet(client, actor.id);
    const exit = viaExit ? await leaveFundInTransaction(client, actor, body.fundId!, shares!) : null;
    const amountUsdc = exit ? exit.virtualUsdc : amount!.toFixed(USDC_DECIMALS);
    if (toRaw(amountUsdc) < limits.withdrawMinRaw) {
      throw new ApiFault(400, "amount_too_small", `Minimum withdrawal is ${fromRaw(limits.withdrawMinRaw)} tokens`);
    }
    const user = await client.query<{ paper_cash: string }>(
      "SELECT paper_cash::text FROM users WHERE id = $1 FOR NO KEY UPDATE", [actor.id]);
    // The user row lock serializes this count with the user's other withdrawals.
    const recent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM token_payouts
       WHERE user_id = $1 AND kind = 'WITHDRAWAL' AND created_at > now() - interval '1 hour'`, [actor.id]);
    if (recent.rows[0]!.count >= limits.withdrawalsPerHour) throw rateLimited("withdrawals", limits.withdrawalsPerHour);
    if (!ataExists) {
      const slots = await client.query<{ ata_creations: number }>(
        "SELECT ata_creations FROM user_wallets WHERE user_id = $1", [actor.id]);
      if (slots.rows[0]!.ata_creations >= MAX_TREASURY_ATA_CREATIONS) {
        throw new ApiFault(409, "token_account_required", tokenAccountRequired);
      }
    }
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

export type DepositFailure =
  "transaction_failed" | "unexpected_instruction" | "wrong_mint" | "wrong_destination" | "wrong_owner" | "wrong_amount";

/**
 * Binds a finalized transaction to one paper action. The transaction must hold exactly one
 * top-level SPL Token transferChecked (compute budget instructions aside) and no inner
 * instructions: our mint, from a token account the user's wallet owns and signs for, to our
 * treasury, for the exact amount. The token balance changes must agree with the instruction.
 */
export function depositFailure(
  tx: ObservedTransaction,
  expected: { mint: string; treasuryAta: string; wallet: string; amountRaw: bigint },
): DepositFailure | null {
  if (tx.failed) return "transaction_failed";
  const instructions = tx.instructions.filter((ix) => !ix.startsWith(`${COMPUTE_BUDGET_PROGRAM}:`));
  if (tx.innerInstructions > 0 || instructions.length !== 1 || tx.transfers.length !== 1
      || instructions[0] !== `${TOKEN_PROGRAM_ADDRESS}:transferChecked`) return "unexpected_instruction";
  const transfer = tx.transfers[0]!;
  if (transfer.mint !== expected.mint) return "wrong_mint";
  if (transfer.destination !== expected.treasuryAta) return "wrong_destination";
  const ours = tx.balances.filter((b) => b.mint === expected.mint);
  const source = ours.find((b) => b.account === transfer.source);
  if (transfer.authority !== expected.wallet || source?.owner !== expected.wallet) return "wrong_owner";
  const treasury = ours.find((b) => b.account === expected.treasuryAta);
  const received = treasury ? treasury.post - treasury.pre : 0n;
  const sent = source.pre - source.post;
  if (transfer.amount !== expected.amountRaw || received !== expected.amountRaw || sent !== expected.amountRaw) {
    return "wrong_amount";
  }
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
  expiry_block_height: string | null;
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

const depositColumns = `id, signature, amount_raw::text, fund_id, status, failure, event_id, join_event_id, join_error,
  expiry_block_height::text, created_at`;

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

async function readDeposit(db: DbPool | DbClient, signature: string, userId: string, lock = false): Promise<DepositRow> {
  const row = (await db.query<DepositRow>(
    `SELECT ${depositColumns} FROM token_deposits WHERE signature = $1 AND user_id = $2${lock ? " FOR UPDATE" : ""}`,
    [signature, userId])).rows[0];
  if (!row) throw new ApiFault(404, "deposit_not_found", "Deposit not found");
  return row;
}

/**
 * Verifies a PENDING or EXPIRED claim. The chain reads run with no transaction open. The credit
 * runs in a short transaction under the claim row lock and only while the row still has the
 * status this call read, so parallel confirms of one signature credit once.
 *
 * Expiry needs all of: no finalized transaction, the signature missing on chain (not processed
 * or confirmed), the finalized height past the claim's expiry height, and DEPOSIT_EXPIRY_SECONDS.
 * EXPIRED is not final: a later call that finds the transaction finalized credits it (or fails
 * it) once. CONFIRMED and FAILED never change.
 */
export async function verifyDeposit(
  pool: DbPool, chain: TokenChain, actor: Actor, signature: string,
  expected: { amountRaw: bigint; fundId: string | null } | null,
): Promise<DepositView> {
  const seen = await readDeposit(pool, signature, actor.id);
  if (expected && (BigInt(seen.amount_raw) !== expected.amountRaw || seen.fund_id !== expected.fundId)) {
    throw new ApiFault(409, "deposit_conflict", "This signature was already submitted with another amount or fund");
  }
  if (seen.status !== "PENDING" && seen.status !== "EXPIRED") return depositView(seen);
  const tx = chain.observePayment ? await chain.observePayment(signature) : await chain.observe(signature);
  const references = tx?.transfers.flatMap(transfer => transfer.references ?? []) ?? [];
  const qrReference = references.length ? (await pool.query("SELECT 1 FROM qr_deposits WHERE reference=ANY($1::text[]) LIMIT 1", [references])).rowCount : 0;
  if (!tx && seen.status === "EXPIRED") return depositView(seen);
  let expire = false;
  if (!tx) {
    // Read the height first: a signature still missing after it passed the bound cannot land.
    const finalized = await chain.blockHeight();
    if (await chain.status(signature) === "missing") {
      if (seen.expiry_block_height === null) {
        const bound = await chain.blockHeight("processed") + DEPOSIT_EXPIRY_BLOCKS;
        await pool.query("UPDATE token_deposits SET expiry_block_height = $2 WHERE id = $1 AND expiry_block_height IS NULL",
          [seen.id, bound.toString()]);
      } else {
        expire = finalized > BigInt(seen.expiry_block_height) && Date.now() - seen.created_at.getTime() > depositExpiryMs();
      }
    }
  }
  const wallet = (await walletOf(pool, actor.id))!;
  return inTransaction(pool, async (client) => {
    const row = await readDeposit(client, signature, actor.id, true);
    if (row.status !== seen.status) return depositView(row);
    const finish = async (sql: string, params: unknown[]) => depositView((await client.query<DepositRow>(
      `UPDATE token_deposits SET ${sql}, updated_at = now() WHERE id = $1 RETURNING ${depositColumns}`,
      [row.id, ...params])).rows[0]!);

    if (!tx) return expire ? finish("status = 'EXPIRED', failure = 'not_found_before_expiry'", []) : depositView(row);
    const failure = depositFailure(tx, { mint: chain.mint, treasuryAta: chain.treasuryAta, wallet, amountRaw: BigInt(row.amount_raw) });
    if (failure) return finish("status = 'FAILED', failure = $2", [failure]);
    if (qrReference) return finish("status = 'FAILED', failure = 'qr_reference_required'", []);

    // Share the receipt key with QR deposits. A signature cannot credit through both APIs.
    const receipt = await client.query(
      "INSERT INTO token_deposit_receipts (signature, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING signature",
      [signature, actor.id]);
    if (!receipt.rowCount) return finish("status = 'FAILED', failure = 'already_credited'", []);
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
    return finish("status = 'CONFIRMED', failure = NULL, event_id = $2, join_event_id = $3, join_error = $4",
      [eventId, joinEventId, joinError]);
  });
}

export async function prepareDeposit(pool: DbPool, chain: TokenChain, actor: Actor, amountUsdc: string) {
  let amountRaw: bigint;
  try { amountRaw = toRaw(amountUsdc); }
  catch { throw new ApiFault(400, "invalid_amount", "amountUsdc must be a decimal string with at most 6 places"); }
  if (amountRaw < 10n ** BigInt(TOKEN_DECIMALS)) throw new ApiFault(400, "amount_too_small", "Minimum deposit is 1 token");
  const wallet = await requireWallet(pool, actor.id);
  // The treasury signs as fee payer for each prepared transaction, so prepares are rate limited.
  const limit = tokenLimits().preparesPerHour;
  await inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('deposit_prepare:' || $1, 0))", [actor.id]);
    await client.query("DELETE FROM deposit_prepares WHERE user_id = $1 AND created_at <= now() - interval '1 hour'", [actor.id]);
    const recent = await client.query("SELECT 1 FROM deposit_prepares WHERE user_id = $1", [actor.id]);
    if (recent.rowCount! >= limit) throw rateLimited("deposit prepares", limit);
    await client.query("INSERT INTO deposit_prepares (user_id) VALUES ($1)", [actor.id]);
  });
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
