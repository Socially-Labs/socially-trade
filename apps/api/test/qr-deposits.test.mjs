import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createSolanaRpcFromTransport, generateKeyPairSigner } from '@solana/kit';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { createApp } from '../dist/app.js';
import { reconcileQrDeposit, sweepQrDeposits, qrPaymentFailure } from '../dist/qr-deposits.js';
import { observePaymentTransaction, TOKEN_PROGRAM_ADDRESS } from '../dist/token-chain.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = () => Array.from(randomBytes(88), b => alphabet[b % 58]).join('');
const addr = async () => (await generateKeyPairSigner()).address;
const ONE = 1_000_000n;

test('external wallet QR funding with persistent database accounting', { timeout: 120_000 }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString); assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1)$/);
  const realFetch = globalThis.fetch;
  const tokenFor = configurePrivyFixture();
  const schema = `qr_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 10 });
  const observed = new Map(); const history = new Map();
  let outage = false;
  const chain = { mint: await addr(), treasuryOwner: await addr(), treasuryAta: await addr(),
    async signaturesForReference(reference, before, until) {
      if (outage) throw new Error('RPC unavailable');
      const rows = history.get(reference) ?? [];
      const start = before ? rows.findIndex(r => r.signature === before) + 1 : 0;
      const end = until ? rows.findIndex(r => r.signature === until) : rows.length;
      return rows.slice(start, end < 0 ? rows.length : end).slice(0, 100);
    },
    observePayment: async signature => observed.get(signature) ?? null,
    observe: async signature => observed.get(signature) ?? null,
    balance: async () => 0n,
  };
  process.env.USDG_MINT = chain.mint;
  const app = createApp(pool, { token: { chain, signupGrantRaw: 100n * ONE } }); app.log.level = 'silent';
  const call = (method, url, subject = 'alice', payload, key) => app.inject({ method, url, payload,
    headers: { authorization: `Bearer ${tokenFor(subject)}`, ...(key ? { 'idempotency-key': key } : {}) } });
  const create = async (subject = 'alice', amount = '10', key = randomUUID()) => {
    const result = await call('POST', '/v0/me/qr-deposits', subject, { amount }, key);
    assert.equal(result.statusCode, 201, result.body); return result.json().deposit;
  };
  const read = async (deposit, subject = 'alice') => (await call('GET', `/v0/me/qr-deposits/${deposit.id}`, subject)).json().deposit;
  const cash = async (subject = 'alice') => (await call('GET', '/v0/me/wallet', subject)).json().available.amount;
  const row = async deposit => (await pool.query('SELECT *,amount_raw::text,credited_raw::text FROM qr_deposits WHERE id=$1', [deposit.id])).rows[0];
  const reconcile = async deposit => reconcileQrDeposit(pool, chain, await row(deposit));
  const payment = (deposit, override = {}) => ({ failed: false, instructions: [`${TOKEN_PROGRAM_ADDRESS}:transferChecked`], innerInstructions: 0,
    transfers: [{ source: 'external-ata', destination: chain.treasuryAta, mint: chain.mint, authority: 'external-wallet', amount: BigInt(deposit.amount.replace('.', '')), references: [deposit.reference] }],
    balances: [{ account: 'external-ata', mint: chain.mint, owner: 'external-wallet', pre: 100n * ONE, post: 90n * ONE },
      { account: chain.treasuryAta, mint: chain.mint, owner: chain.treasuryOwner, pre: 1_000n * ONE, post: 1_010n * ONE }], ...override });
  const add = (deposit, tx = payment(deposit), finalized = true) => {
    const signature = sig();
    history.set(deposit.reference, [{ signature, failed: tx.failed }, ...(history.get(deposit.reference) ?? [])]);
    if (finalized) observed.set(signature, tx);
    return signature;
  };
  try {
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await t.test('QR is owned by the authenticated account and creation retries reuse it', async () => {
      const deposit = await create('alice', '10', 'same-key-0001');
      const replay = await create('alice', '10.000000', 'same-key-0001');
      assert.equal(replay.id, deposit.id); assert.equal(replay.reference, deposit.reference);
      const url = new URL(deposit.paymentUrl);
      assert.equal(url.pathname, chain.treasuryOwner); assert.equal(url.searchParams.get('spl-token'), chain.mint);
      assert.equal(url.searchParams.get('reference'), deposit.reference); assert.equal(deposit.token.cluster, 'devnet');
      assert.equal((await call('GET', `/v0/me/qr-deposits/${deposit.id}`, 'bob')).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: '/v0/me/wallet' })).statusCode, 401);
      assert.equal((await call('POST', '/v0/me/qr-deposits', 'alice', { amount: '11' }, 'same-key-0001')).statusCode, 409);
      assert.equal(await cash(), '0.000000000000000000', 'QR funding needs no personal wallet or signup grant');
    });
    await t.test('invalid amounts and unsupported networks cannot create payments', async () => {
      for (const amount of ['0', '0.9', '1.0000001', '1000001', '-1', '1e3', 'NaN', '0001', '9'.repeat(40)])
        assert.equal((await call('POST', '/v0/me/qr-deposits', 'alice', { amount }, randomUUID())).statusCode, 400, amount);
      assert.equal((await call('POST', '/v0/me/qr-deposits', 'alice', { amount: '10', network: 'ethereum' }, randomUUID())).statusCode, 400);
      assert.equal((await call('POST', '/v0/me/qr-deposits', 'alice', { amount: '10' })).statusCode, 400);
    });
    await t.test('confirmed-but-not-finalized transactions wait; concurrent finalization credits once', async () => {
      const deposit = await create(); const tx = payment(deposit); const signature = add(deposit, tx, false);
      await reconcile(deposit); assert.equal((await read(deposit)).status, 'CONFIRMING'); assert.equal(await cash(), '0.000000000000000000');
      observed.set(signature, tx);
      await Promise.all(Array.from({ length: 6 }, () => reconcile(deposit)));
      assert.equal((await read(deposit)).status, 'CONFIRMED'); assert.equal(await cash(), '10.000000000000000000');
      assert.equal((await pool.query('SELECT 1 FROM token_deposit_receipts WHERE signature=$1', [signature])).rowCount, 1);
      assert.equal((await pool.query("SELECT 1 FROM fund_events WHERE type='devnet_qr_deposit_confirmed'")).rowCount, 1);
      await reconcile(deposit); assert.equal(await cash(), '10.000000000000000000');
    });
    await t.test('wrong token, destination, amount, reference and malicious instructions never credit', async () => {
      const cases = [
        ['wrong_mint', tx => { tx.transfers[0].mint = 'wrong'; }],
        ['wrong_destination', tx => { tx.transfers[0].destination = 'wrong'; }],
        ['wrong_amount', tx => { tx.transfers[0].amount++; }],
        ['wrong_amount', tx => { tx.balances[1].post++; }],
        ['wrong_reference', tx => { tx.transfers[0].references = []; }],
        ['wrong_reference', tx => { tx.transfers[0].references.push('other'); }],
        ['unexpected_transfers', tx => { tx.transfers.push(tx.transfers[0]); }],
        ['unexpected_instruction', tx => { tx.instructions.push('evil:drain'); }],
      ];
      for (const [failure, mutate] of cases) {
        const deposit = await create('bob'); const tx = payment(deposit); mutate(tx); add(deposit, tx);
        await reconcile(deposit); const state = await read(deposit, 'bob');
        assert.equal(state.lastError, failure); assert.equal(state.status, 'WAITING');
      }
      assert.equal(await cash('bob'), '0.000000000000000000');
      const deposit = await create('bob'); add(deposit, payment(deposit, { failed: true })); await reconcile(deposit);
      assert.equal(await cash('bob'), '0.000000000000000000');
      assert.equal(qrPaymentFailure(payment(deposit, { failed: true }), await row(deposit)), 'transaction_failed');
    });
    await t.test('a valid retry after an invalid payment succeeds and clears the error', async () => {
      const deposit = await create(); const bad = payment(deposit); bad.transfers[0].amount--; add(deposit, bad);
      await reconcile(deposit); assert.equal((await read(deposit)).lastError, 'wrong_amount');
      add(deposit); await reconcile(deposit); assert.equal((await read(deposit)).status, 'CONFIRMED'); assert.equal((await read(deposit)).lastError, null);
    });
    await t.test('expiration is not permission to lose a late finalized payment', async () => {
      const deposit = await create(); await pool.query("UPDATE qr_deposits SET expires_at=now()-interval '1 day' WHERE id=$1", [deposit.id]);
      await reconcile(deposit); assert.equal((await read(deposit)).status, 'EXPIRED');
      add(deposit); await pool.query('UPDATE qr_deposits SET next_scan_at=now() WHERE id=$1', [deposit.id]);
      await sweepQrDeposits(pool, chain); assert.equal((await read(deposit)).status, 'CONFIRMED');
    });
    await t.test('two actual payments credit twice, but each signature credits only once', async () => {
      const deposit = await create(); add(deposit); add(deposit);
      await reconcile(deposit); await reconcile(deposit);
      assert.equal((await read(deposit)).creditedAmount, '20.000000');
    });
    await t.test('discovery pagination cannot hide a valid payment behind 100 other signatures', async () => {
      const deposit = await create(); add(deposit);
      for (let i = 0; i < 101; i++) add(deposit, payment(deposit, { failed: true }));
      await reconcile(deposit); assert.ok((await row(deposit)).scan_before); assert.equal((await read(deposit)).creditedAmount, '0.000000');
      await reconcile(deposit); assert.equal((await read(deposit)).creditedAmount, '10.000000'); assert.equal((await row(deposit)).scan_before, null);
    });
    await t.test('RPC outage does not mark a payment failed; another worker recovers persisted work', async () => {
      const deposit = await create(); add(deposit); outage = true;
      const errors = []; await sweepQrDeposits(pool, chain, error => errors.push(error));
      assert.ok(errors.length > 0); assert.equal((await read(deposit)).creditedAmount, '0.000000'); outage = false;
      await pool.query('UPDATE qr_deposits SET next_scan_at=now() WHERE id=$1', [deposit.id]);
      await sweepQrDeposits(pool, chain); assert.equal((await read(deposit)).status, 'CONFIRMED');
    });
    await t.test('linking a wallet after QR funding keeps the available balance', async () => {
      const deposit = await create('later'); add(deposit); await reconcile(deposit);
      const owner = (await row(deposit)).user_id;
      const { bindWallet } = await import('../dist/token-flows.js');
      const before = await cash('later');
      await bindWallet(pool, { chain, signupGrantRaw: 100n * ONE, allowUnverifiedWallet: true }, { id: owner, subject: 'did:privy:later' }, await addr());
      assert.equal(await cash('later'), before);
      assert.equal((await pool.query('SELECT 1 FROM token_payouts WHERE user_id=$1', [owner])).rowCount, 0);
    });
    await t.test('legacy claim cannot double-credit a QR receipt', async () => {
      const deposit = await create(); const tx = payment(deposit); const wallet = await addr();
      tx.transfers[0].authority = wallet; tx.balances[0].owner = wallet;
      const signature = add(deposit, tx); await reconcile(deposit);
      const owner = (await row(deposit)).user_id; await pool.query('INSERT INTO user_wallets(user_id,address) VALUES ($1,$2)', [owner, wallet]);
      const before = await cash(); const result = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '10' });
      assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().deposit.failure, 'qr_reference_required'); assert.equal(await cash(), before);
    });
    await t.test('a sender cannot redirect a QR payment through the legacy endpoint before the worker sees it', async () => {
      const deposit = await create('bob'); const tx = payment(deposit);
      const wallet = (await pool.query("SELECT address FROM user_wallets WHERE user_id=(SELECT id FROM users WHERE auth_subject='did:privy:alice')")).rows[0].address;
      tx.transfers[0].authority = wallet; tx.balances[0].owner = wallet;
      const signature = add(deposit, tx); const before = await cash();
      const claim = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '10' });
      assert.equal(claim.json().deposit.failure, 'qr_reference_required'); assert.equal(await cash(), before);
      await reconcile(deposit); assert.equal((await read(deposit, 'bob')).status, 'CONFIRMED');
      assert.equal(await cash('bob'), '10.000000000000000000');
    });
    await t.test('rate limit holds under concurrent creation and accounting stays balanced', async () => {
      const results = await Promise.all(Array.from({ length: 25 }, () => call('POST', '/v0/me/qr-deposits', 'limited', { amount: '10' }, randomUUID())));
      assert.equal(results.filter(r => r.statusCode === 201).length, 20); assert.equal(results.filter(r => r.statusCode === 429).length, 5);
      const unbalanced = await pool.query('SELECT event_id FROM ledger_entries GROUP BY event_id HAVING sum(amount)<>0'); assert.equal(unbalanced.rowCount, 0);
      const users = await pool.query(`SELECT u.paper_cash::text,COALESCE(sum(e.amount),0)::text AS ledger FROM users u
        LEFT JOIN ledger_accounts a ON a.owner_type='USER' AND a.owner_id=u.id::text AND a.asset_id='USDC'
        LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY u.id`);
      for (const user of users.rows) assert.equal(Number(user.paper_cash), Number(user.ledger));
    });
  } finally { globalThis.fetch = realFetch; await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); delete process.env.USDG_MINT; }
});

// Start from a recorded finalized SPL transfer. Add a Solana Pay reference to its compiled
// accounts to test the real adapter's second (json) read, which jsonParsed alone cannot prove.
test('Solana decoder proves a reference is read-only and attached to the transfer', async () => {
  const parsed = JSON.parse(await readFile(new URL('./fixtures/devnet-tx-deposit.json', import.meta.url), 'utf8'));
  const reference = await addr();
  const raw = structuredClone(parsed);
  const originalKeys = parsed.transaction.message.accountKeys;
  const keys = [...originalKeys.map(k => k.pubkey), reference];
  raw.transaction.message.accountKeys = keys;
  raw.transaction.message.header = {
    numRequiredSignatures: originalKeys.filter(k => k.signer).length,
    numReadonlySignedAccounts: originalKeys.filter(k => k.signer && !k.writable).length,
    numReadonlyUnsignedAccounts: originalKeys.filter(k => !k.signer && !k.writable).length + 1,
  };
  const info = parsed.transaction.message.instructions[0].parsed.info;
  raw.transaction.message.instructions = [{ programIdIndex: keys.indexOf(TOKEN_PROGRAM_ADDRESS),
    accounts: [info.source, info.mint, info.destination, info.authority, reference].map(k => keys.indexOf(k)), data: '' }];
  const observe = async fixture => {
    const requests = [];
    const rpc = createSolanaRpcFromTransport(async ({ payload }) => {
      requests.push(payload);
      return { jsonrpc: '2.0', id: payload.id, result: payload.params[1].encoding === 'jsonParsed' ? parsed : fixture };
    });
    const tx = await observePaymentTransaction(rpc, parsed.transaction.signatures[0]);
    for (const request of requests) assert.equal(request.params[1].commitment ?? 'finalized', 'finalized');
    return tx;
  };
  assert.deepEqual((await observe(raw)).transfers[0].references, [reference]);
  const unattached = structuredClone(raw); unattached.transaction.message.instructions[0].accounts.pop();
  assert.deepEqual((await observe(unattached)).transfers[0].references, []);
  const writable = structuredClone(raw); writable.transaction.message.header.numReadonlyUnsignedAccounts = 0;
  assert.deepEqual((await observe(writable)).transfers[0].references, []);
  assert.equal(await observe(null), null);
});
