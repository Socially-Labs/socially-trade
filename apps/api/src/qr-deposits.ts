import { randomUUID } from "node:crypto";
import { generateKeyPairSigner } from "@solana/kit";
import { inTransaction, type DbPool } from "@socially/db";
import type { Actor } from "./auth.js";
import { beginIdempotent, finishIdempotent } from "./accounting.js";
import { ApiFault } from "./errors.js";
import { myPositions } from "./crew.js";
import { moveTreasuryLedger, tokenInfo } from "./token-flows.js";
import { COMPUTE_BUDGET_PROGRAM, fromRaw, TOKEN_PROGRAM_ADDRESS, toRaw, type ObservedTransaction, type TokenChain } from "./token-chain.js";

type Row = {
  id: string; user_id: string; reference: string; mint: string; recipient: string; treasury_ata: string;
  amount_raw: string; credited_raw: string; status: "WAITING" | "CONFIRMING" | "CONFIRMED" | "EXPIRED";
  signature: string | null; last_error: string | null; expires_at: Date; created_at: Date;
  scan_until: string | null; scan_before: string | null; scan_head: string | null;
};
const columns = "*, amount_raw::text, credited_raw::text";
export const qrEnabled = (chain: TokenChain | null) => Boolean(chain?.treasuryOwner && chain.signaturesForReference && chain.observePayment);
const view = (row: Row, chain: TokenChain | null) => ({
  canPay: Boolean(qrEnabled(chain) && row.mint === chain!.mint && row.recipient === chain!.treasuryOwner &&
    row.treasury_ata === chain!.treasuryAta && row.expires_at.getTime() > Date.now() && (row.status === "WAITING" || row.status === "CONFIRMING")),
  id: row.id, reference: row.reference, amount: fromRaw(row.amount_raw), creditedAmount: fromRaw(row.credited_raw),
  status: row.status, signature: row.signature, lastError: row.last_error,
  expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(),
  token: { label: "Test USDC (devnet)", mint: row.mint, decimals: 6, cluster: "devnet" },
  // A Solana Pay SPL transfer recipient is the treasury OWNER, not its token account.
  paymentUrl: `solana:${row.recipient}?${new URLSearchParams({ amount: fromRaw(row.amount_raw),
    "spl-token": row.mint, reference: row.reference, label: "Socially", message: "Add test USDC to your trading balance" })}`,
});

export async function createQrDeposit(pool: DbPool, chain: TokenChain, actor: Actor, key: string, amount: string) {
  if (!qrEnabled(chain)) throw new ApiFault(503, "funding_unavailable", "Devnet funding is not configured");
  let raw: bigint;
  try { raw = toRaw(amount); } catch { throw new ApiFault(400, "invalid_amount", "Use a decimal amount with at most 6 places"); }
  if (raw < 1_000_000n || raw > 1_000_000_000_000n) throw new ApiFault(400, "invalid_amount", "Deposit between 1 and 1,000,000 test USDC");
  const reference = (await generateKeyPairSigner()).address;
  return inTransaction(pool, async client => {
    const body = { amount: fromRaw(raw) };
    const replay = await beginIdempotent<{ id: string }>(client, actor.id, key, "qr-deposit", body);
    if (replay) return view((await client.query<Row>(`SELECT ${columns} FROM qr_deposits WHERE id = $1 AND user_id = $2`, [replay.id, actor.id])).rows[0]!, chain);
    // Serialize the per-user rate limit, including concurrent requests with different keys.
    await client.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [actor.id]);
    const count = await client.query<{ count: string }>("SELECT count(*) FROM qr_deposits WHERE user_id = $1 AND created_at > now() - interval '1 hour'", [actor.id]);
    if (Number(count.rows[0]!.count) >= 20) throw new ApiFault(429, "rate_limited", "Too many deposit requests. Try again later");
    const row = (await client.query<Row>(`INSERT INTO qr_deposits (id, user_id, reference, mint, recipient, treasury_ata, amount_raw)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
      [randomUUID(), actor.id, reference, chain.mint, chain.treasuryOwner, chain.treasuryAta, raw.toString()])).rows[0]!;
    await finishIdempotent(client, actor.id, key, { id: row.id }, 201);
    return view(row, chain);
  });
}

export async function readQrDeposit(pool: DbPool, userId: string, id: string, chain: TokenChain | null) {
  const row = (await pool.query<Row>(`SELECT ${columns} FROM qr_deposits WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0];
  if (!row) throw new ApiFault(404, "deposit_not_found", "Deposit request not found");
  return view(row, chain);
}

/** Verification never trusts a client's success flag, signature or sender address. */
export function qrPaymentFailure(tx: ObservedTransaction, expected: Pick<Row, "reference" | "mint" | "treasury_ata" | "amount_raw">): string | null {
  if (tx.failed) return "transaction_failed";
  if (tx.transfers.length !== 1) return "unexpected_transfers";
  const transfer = tx.transfers[0]!;
  // Exactly one reference on THIS transfer prevents a payment being claimed by multiple QR requests.
  if (transfer.references?.length !== 1 || transfer.references[0] !== expected.reference) return "wrong_reference";
  const permitted = tx.instructions.every(ix => ix.startsWith(`${COMPUTE_BUDGET_PROGRAM}:`) ||
    ix.startsWith("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr:") ||
    ix.startsWith("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo:") ||
    ix.startsWith("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL:") ||
    ix === `${TOKEN_PROGRAM_ADDRESS}:transferChecked` || ix === `${TOKEN_PROGRAM_ADDRESS}:transfer`);
  if (!permitted) return "unexpected_instruction";
  if (transfer.destination !== expected.treasury_ata || transfer.source === expected.treasury_ata) return "wrong_destination";
  if (transfer.mint !== null && transfer.mint !== expected.mint) return "wrong_mint";
  const source = tx.balances.find(b => b.account === transfer.source && b.mint === expected.mint);
  const destination = tx.balances.find(b => b.account === expected.treasury_ata && b.mint === expected.mint);
  if (!source || !destination) return "wrong_mint";
  const amount = BigInt(expected.amount_raw);
  if (transfer.amount !== amount || source.pre - source.post !== amount || destination.post - destination.pre !== amount) return "wrong_amount";
  return null;
}

async function settleAttempt(pool: DbPool, chain: TokenChain, row: Row, signature: string) {
  await pool.query("UPDATE qr_deposit_attempts SET last_checked_at=now() WHERE deposit_id=$1 AND signature=$2", [row.id, signature]);
  const tx = await chain.observePayment!(signature); // adapter returns FINALIZED only
  if (!tx) return;
  const failure = qrPaymentFailure(tx, row);
  await inTransaction(pool, async client => {
    const current = (await client.query<Row>(`SELECT ${columns} FROM qr_deposits WHERE id = $1 FOR UPDATE`, [row.id])).rows[0]!;
    const attempt = (await client.query<{ status: string }>("SELECT status FROM qr_deposit_attempts WHERE deposit_id=$1 AND signature=$2 FOR UPDATE", [row.id, signature])).rows[0];
    if (!attempt || attempt.status !== "PENDING") return;
    let rejection = failure;
    if (!rejection) {
      const receipt = await client.query("INSERT INTO token_deposit_receipts(signature,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING signature", [signature, row.user_id]);
      if (!receipt.rowCount) rejection = "already_credited";
    }
    if (rejection) {
      await client.query("UPDATE qr_deposit_attempts SET status='REJECTED',failure=$3 WHERE deposit_id=$1 AND signature=$2", [row.id, signature, rejection]);
      await client.query("UPDATE qr_deposits SET last_error=$2,updated_at=now() WHERE id=$1", [row.id, rejection]);
      return;
    }
    const amount = fromRaw(row.amount_raw);
    await client.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [row.user_id]);
    await client.query("UPDATE users SET paper_cash=paper_cash+$2::numeric WHERE id=$1", [row.user_id, amount]);
    const eventId = await moveTreasuryLedger(client, row.user_id, "devnet_qr_deposit_confirmed", { userId: row.user_id, depositId: row.id, signature, amount, asset: "USDC" }, amount);
    await client.query("UPDATE qr_deposit_attempts SET status='CREDITED',event_id=$3 WHERE deposit_id=$1 AND signature=$2", [row.id, signature, eventId]);
    await client.query(`UPDATE qr_deposits SET status='CONFIRMED',credited_raw=credited_raw+$2::numeric,
      signature=COALESCE(signature,$3),last_error=NULL,updated_at=now() WHERE id=$1`, [current.id, row.amount_raw, signature]);
  });
}

/** One bounded discovery page per sweep; pending confirmations are retried independently. */
export async function reconcileQrDeposit(pool: DbPool, chain: TokenChain, row: Row) {
  if (row.mint !== chain.mint || row.treasury_ata !== chain.treasuryAta || row.recipient !== chain.treasuryOwner) {
    throw new Error("QR deposit belongs to another token configuration");
  }
  const signatures = await chain.signaturesForReference!(row.reference, row.scan_before ?? undefined, row.scan_until ?? undefined);
  await inTransaction(pool, async client => {
    for (const candidate of signatures) {
      await client.query(`INSERT INTO qr_deposit_attempts(deposit_id,signature,status,failure) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [row.id, candidate.signature, candidate.failed ? "REJECTED" : "PENDING", candidate.failed ? "transaction_failed" : null]);
      if (candidate.failed) await client.query("UPDATE qr_deposits SET last_error='transaction_failed' WHERE id=$1 AND credited_raw=0", [row.id]);
    }
    const head = row.scan_head ?? signatures[0]?.signature ?? row.scan_until;
    const more = signatures.length === 100;
    await client.query("UPDATE qr_deposits SET scan_before=$2,scan_head=$3,scan_until=$4 WHERE id=$1",
      [row.id, more ? signatures.at(-1)!.signature : null, more ? head : null, more ? row.scan_until : head]);
  });
  const pending = await pool.query<{ signature: string }>("SELECT signature FROM qr_deposit_attempts WHERE deposit_id=$1 AND status='PENDING' ORDER BY last_checked_at,created_at,signature LIMIT 4", [row.id]);
  for (const { signature } of pending.rows) await settleAttempt(pool, chain, row, signature);
  await pool.query(`UPDATE qr_deposits SET
    status=CASE WHEN credited_raw>0 THEN 'CONFIRMED'
      WHEN EXISTS(SELECT 1 FROM qr_deposit_attempts WHERE deposit_id=$1 AND status='PENDING') THEN 'CONFIRMING'
      WHEN expires_at<=now() THEN 'EXPIRED' ELSE 'WAITING' END,
    next_scan_at=now()+CASE WHEN scan_before IS NOT NULL OR EXISTS(SELECT 1 FROM qr_deposit_attempts WHERE deposit_id=$1 AND status='PENDING') THEN interval '5 seconds'
      WHEN expires_at>now() THEN interval '5 seconds' ELSE interval '1 hour' END,
    updated_at=now() WHERE id=$1`, [row.id]);
}

export async function sweepQrDeposits(pool: DbPool, chain: TokenChain, onError: (error: unknown) => void = () => {}) {
  // Persistent lease and SKIP LOCKED make multiple API instances cooperate. A crash releases
  // work after the lease; receipts make a repeated reconciliation harmless.
  const rows = await pool.query<Row>(`UPDATE qr_deposits SET next_scan_at=now()+interval '5 minutes' WHERE id IN
    (SELECT id FROM qr_deposits WHERE next_scan_at<=now() ORDER BY next_scan_at LIMIT 4 FOR UPDATE SKIP LOCKED) RETURNING ${columns}`);
  await Promise.all(rows.rows.map(async row => {
    try { await reconcileQrDeposit(pool, chain, row); }
    catch (error) { onError(error); await pool.query("UPDATE qr_deposits SET next_scan_at=now()+interval '15 seconds' WHERE id=$1", [row.id]); }
  }));
}

export function startQrDepositWorker(pool: DbPool, chain: TokenChain, onError: (error: unknown) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = sweepQrDeposits(pool, chain, onError).catch(onError).finally(() => {
      if (!stopped) { timer = setTimeout(tick, 2_000); timer.unref(); }
    });
  };
  timer = setTimeout(tick, 0);
  return async () => { stopped = true; clearTimeout(timer); await running; };
}

export async function fundingSummary(pool: DbPool, chain: TokenChain | null, actor: Actor) {
  return inTransaction(pool, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cash = (await client.query<{ value: string }>("SELECT paper_cash::text AS value FROM users WHERE id=$1", [actor.id])).rows[0]!.value;
    const deposits = await client.query<Row>(`SELECT ${columns} FROM qr_deposits WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`, [actor.id]);
    return { mode: "PAPER", enabled: qrEnabled(chain), token: chain ? tokenInfo(chain) : null,
      available: { amount: cash, asset: "USDC" }, positions: await myPositions(client, actor.id), deposits: deposits.rows.map(row => view(row, chain)) };
  });
}
