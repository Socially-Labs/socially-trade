import { configurePrivyFixture } from './privy-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createSolanaRpcFromTransport, generateKeyPairSigner } from '@solana/kit';
import { createApp } from '../dist/app.js';
import {
  assertDevnetGenesis, assertNotMainnetUrl, assertOwnedMint, DEVNET_GENESIS_HASH, loadTokenConfig, observeTransaction,
  parseKeypair, TOKEN_PROGRAM_ADDRESS, withTimeout,
} from '../dist/token-chain.js';
import { depositFailure } from '../dist/token-flows.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeSignature = () => Array.from(randomBytes(88), b => B58[b % 58]).join('');
const newAddress = async () => (await generateKeyPairSigner()).address;
const ONE = 1_000_000n;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// In-memory stand-in for the TokenChain seam. Like a real cluster, one signature executes once.
class FakeChain {
  static async create() {
    const chain = new FakeChain();
    chain.mint = await newAddress(); chain.treasuryAta = await newAddress(); chain.otherMint = await newAddress();
    return chain;
  }
  height = 1_000n; txs = new Map(); landed = new Map(); sends = []; signed = 0; dropSends = false; wallets = new Map();
  atas = new Set(); slowMs = 0;
  async observe(signature) { await sleep(this.slowMs); return this.txs.get(signature) ?? null; }
  async status(signature) { await sleep(this.slowMs); return this.landed.get(signature) ?? 'missing'; }
  async blockHeight() { await sleep(this.slowMs); return this.height; }
  async signMint(owner, raw, createAta) { return this.sign('mint', owner, raw, createAta); }
  async signPayout(owner, raw, createAta) { return this.sign('payout', owner, raw, createAta); }
  sign(kind, owner, raw, createAta) {
    this.signed++;
    const signature = fakeSignature();
    return { signature, lastValidBlockHeight: this.height + 150n,
      wire: JSON.stringify({ signature, kind, owner, raw: String(raw), createAta }) };
  }
  async send(wire) {
    const tx = JSON.parse(wire);
    this.sends.push(tx);
    if (this.dropSends || this.landed.has(tx.signature)) return;
    // Like the token program: without a create instruction the payout needs an existing account.
    if (!tx.createAta && !this.atas.has(tx.owner)) { this.landed.set(tx.signature, 'failed'); return; }
    this.atas.add(tx.owner);
    this.landed.set(tx.signature, 'confirmed');
    this.wallets.set(tx.owner, (this.wallets.get(tx.owner) ?? 0n) + BigInt(tx.raw));
  }
  async tokenAccountExists(owner) { return this.atas.has(owner); }
  landedFor(owner, kind) { return this.sends.filter(s => s.owner === owner && s.kind === kind && this.landed.get(s.signature) === 'confirmed')
    .filter((s, i, all) => all.findIndex(x => x.signature === s.signature) === i); }
  async prepareDeposit(owner, raw) {
    return { transaction: Buffer.from(JSON.stringify({ owner, raw: String(raw) })).toString('base64'), lastValidBlockHeight: this.height + 150n };
  }
  async balance(owner) { return this.wallets.get(owner) ?? 0n; }
  /** A finalized user transferChecked, as observe() reports it. */
  transfer({ owner, raw, sent = raw, mint = this.mint, destination = this.treasuryAta, failed = false }) {
    const signature = fakeSignature();
    this.txs.set(signature, { failed, instructions: [`${TOKEN_PROGRAM_ADDRESS}:transferChecked`], innerInstructions: 0,
      transfers: [{ source: `ata:${owner}`, destination, mint, authority: owner, amount: raw }],
      balances: [
        { account: `ata:${owner}`, mint, owner, pre: 50_000n * ONE, post: 50_000n * ONE - sent },
        { account: destination, mint, owner: 'treasury-owner', pre: 7n * ONE, post: 7n * ONE + raw },
      ] });
    return signature;
  }
}

test('devnet token layer with a fake chain', { timeout: 120_000 }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  process.env.NODE_ENV = 'development';
  process.env.PAYOUT_CONFIRM_WAIT_MS = '2000';
  delete process.env.PRIVY_APP_SECRET;
  const tokenFor = configurePrivyFixture();
  const chain = await FakeChain.create();
  process.env.USDG_MINT = chain.mint;
  const schema = `devnet_token_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  // The same pool size as production (createPool), so a route that holds connections shows up.
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 10 });
  const layer = { chain, signupGrantRaw: 10_000n * ONE, allowUnverifiedWallet: true };
  const app = createApp(pool, { token: layer });
  app.log.level = 'silent';
  const call = (method, url, subject, payload, key) => app.inject({ method, url, payload,
    headers: { authorization: `Bearer ${tokenFor(subject)}`, ...(key ? { 'idempotency-key': key } : {}) } });
  const bootstrap = (subject, walletAddress) => call('POST', '/v0/auth/privy', subject, walletAddress ? { walletAddress } : undefined);
  const paperCash = async subject => (await call('GET', '/v0/me', subject)).json().paperCash.value;
  const wallets = {};
  try {
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    for (const name of ['alice', 'bob', 'cap', 'carol']) wallets[name] = await newAddress();

    await t.test('signup mints the grant exactly once across parallel bootstraps and retries', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => bootstrap('alice', wallets.alice)));
      for (const r of results) assert.equal(r.statusCode, 200, r.body);
      const [first] = results.map(r => r.json());
      assert.equal(first.wallet, wallets.alice);
      assert.equal(first.token.mint, chain.mint);
      assert.equal(first.user.paperCash.value, '0.000000000000000000', 'no paper grant when the token layer is on');
      const retry = (await bootstrap('alice')).json();
      assert.equal(retry.signupGrant.status, 'CONFIRMED');
      assert.equal(chain.landedFor(wallets.alice, 'mint').length, 1, 'one mint landed');
      assert.equal(chain.signed, 1, 'one mint transaction was ever signed');
      assert.equal(await chain.balance(wallets.alice), 10_000n * ONE);
      const rows = await pool.query("SELECT signature, status FROM token_payouts WHERE kind = 'SIGNUP_GRANT'");
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].signature, retry.signupGrant.signature);
    });

    await t.test('wallet binding validates, is permanent and is unique per user', async () => {
      assert.equal((await bootstrap('bob', 'not-an-address')).statusCode, 400);
      assert.equal((await bootstrap('bob', wallets.alice)).json().error, 'wallet_in_use');
      const bob = await bootstrap('bob', wallets.bob);
      assert.equal(bob.statusCode, 200, bob.body);
      assert.equal(bob.json().signupGrant.status, 'CONFIRMED');
      const swap = await bootstrap('bob', wallets.carol);
      assert.equal(swap.statusCode, 409); assert.equal(swap.json().error, 'wallet_mismatch');
      const none = (await bootstrap('nowallet')).json();
      assert.equal(none.wallet, null); assert.equal(none.signupGrant, null);
      assert.equal((await call('POST', '/v0/me/deposits/prepare', 'nowallet', { amountUsdc: '5' })).json().error, 'wallet_required');
    });

    await t.test('Privy linked wallets decide the binding when the app secret is set', async () => {
      const embedded = await newAddress(); const external = await newAddress(); const stranger = await newAddress();
      const fixtureFetch = globalThis.fetch;
      process.env.PRIVY_APP_SECRET = 'test-secret';
      globalThis.fetch = async (input, options) => {
        if (String(input) === 'https://api.privy.io/v1/users/did%3Aprivy%3Adave') {
          assert.equal(options.headers['privy-app-id'], 'local-paper-test');
          return Response.json({ linked_accounts: [
            { type: 'wallet', chain_type: 'solana', address: external, wallet_client_type: 'phantom' },
            { type: 'wallet', chain_type: 'ethereum', address: '0xabc' },
            { type: 'wallet', chain_type: 'solana', address: embedded, wallet_client_type: 'privy' },
          ] });
        }
        return fixtureFetch(input, options);
      };
      try {
        const denied = await bootstrap('dave', stranger);
        assert.equal(denied.statusCode, 403); assert.equal(denied.json().error, 'wallet_not_linked');
        const dave = await bootstrap('dave');
        assert.equal(dave.statusCode, 200, dave.body); assert.equal(dave.json().wallet, embedded);
      } finally { globalThis.fetch = fixtureFetch; delete process.env.PRIVY_APP_SECRET; }
    });

    await t.test('without Privy verification the wallet bind fails closed, in any NODE_ENV', async () => {
      layer.allowUnverifiedWallet = false;
      try {
        for (const env of ['development', 'test', 'production']) {
          process.env.NODE_ENV = env;
          const blocked = await bootstrap('erin', await newAddress());
          assert.equal(blocked.statusCode, 503); assert.equal(blocked.json().error, 'wallet_verification_unconfigured');
        }
        assert.equal((await pool.query("SELECT 1 FROM user_wallets w JOIN users u ON u.id = w.user_id WHERE u.auth_subject = 'did:privy:erin'")).rowCount, 0);
      } finally { layer.allowUnverifiedWallet = true; process.env.NODE_ENV = 'development'; }
    });

    await t.test('prepare returns an unsigned-by-user transfer for the bound wallet', async () => {
      const r = await call('POST', '/v0/me/deposits/prepare', 'alice', { amountUsdc: '25.5' });
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json();
      assert.equal(body.amountUsdc, '25.500000'); assert.equal(body.treasuryTokenAccount, chain.treasuryAta);
      assert.deepEqual(JSON.parse(Buffer.from(body.transaction, 'base64').toString()), { owner: wallets.alice, raw: '25500000' });
      assert.equal((await call('POST', '/v0/me/deposits/prepare', 'alice', { amountUsdc: '0.5' })).json().error, 'amount_too_small');
      assert.equal((await call('POST', '/v0/me/deposits/prepare', 'alice', { amountUsdc: '1.0000001' })).json().error, 'invalid_amount');
    });

    await t.test('5 parallel confirms of one signature credit the paper ledger once', async () => {
      const signature = chain.transfer({ owner: wallets.alice, raw: 500n * ONE });
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '500' })));
      for (const r of results) { assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().deposit.status, 'CONFIRMED'); }
      assert.equal(await paperCash('alice'), '500.000000000000000000');
      assert.equal((await pool.query("SELECT 1 FROM fund_events WHERE type = 'devnet_deposit_confirmed'")).rowCount, 1);
      const again = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '500.000000' });
      assert.equal(again.json().deposit.status, 'CONFIRMED');
      const conflict = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '400' });
      assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error, 'deposit_conflict');
      const status = await call('GET', `/v0/me/deposits/${signature}`, 'alice');
      assert.equal(status.statusCode, 200); assert.equal(status.json().deposit.amount, '500.000000');
      assert.equal(await paperCash('alice'), '500.000000000000000000');
    });

    await t.test('wrong mint, amount, destination, owner and failed transactions never credit', async () => {
      const cases = [
        [chain.transfer({ owner: wallets.alice, raw: 10n * ONE, mint: chain.otherMint }), 'wrong_mint'],
        [chain.transfer({ owner: wallets.alice, raw: 9n * ONE }), 'wrong_amount'],
        [chain.transfer({ owner: wallets.alice, raw: 10n * ONE, sent: 11n * ONE }), 'wrong_amount'],
        [chain.transfer({ owner: wallets.alice, raw: 10n * ONE, destination: 'someone-else-ata' }), 'wrong_destination'],
        [chain.transfer({ owner: wallets.carol, raw: 10n * ONE }), 'wrong_owner'],
        [chain.transfer({ owner: wallets.alice, raw: 10n * ONE, failed: true }), 'transaction_failed'],
      ];
      for (const [signature, failure] of cases) {
        const r = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '10' });
        assert.equal(r.statusCode, 200, r.body);
        assert.equal(r.json().deposit.status, 'FAILED'); assert.equal(r.json().deposit.failure, failure);
      }
      assert.equal(await paperCash('alice'), '500.000000000000000000');
    });

    await t.test('a stranger who posts a signature first cannot steal or block it', async () => {
      const signature = chain.transfer({ owner: wallets.bob, raw: 20n * ONE });
      const stolen = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '20' });
      assert.equal(stolen.json().deposit.failure, 'wrong_owner');
      const owner = await call('POST', '/v0/me/deposits', 'bob', { signature, amountUsdc: '20' });
      assert.equal(owner.json().deposit.status, 'CONFIRMED');
      assert.equal(await paperCash('bob'), '20.000000000000000000');
      assert.equal(await paperCash('alice'), '500.000000000000000000');
      assert.equal((await call('GET', `/v0/me/deposits/${fakeSignature()}`, 'bob')).statusCode, 404);
    });

    await t.test('an unseen signature expires only past its height bound; a late finalized transfer credits once', async () => {
      const signature = fakeSignature();
      const pending = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '30' });
      assert.equal(pending.statusCode, 202); assert.equal(pending.json().deposit.status, 'PENDING');
      // Wall clock alone does not expire it: the chain has not passed the claim's height bound.
      await pool.query("UPDATE token_deposits SET created_at = now() - interval '10 minutes' WHERE signature = $1", [signature]);
      const early = await call('GET', `/v0/me/deposits/${signature}`, 'alice');
      assert.equal(early.statusCode, 202); assert.equal(early.json().deposit.status, 'PENDING');
      chain.height += 301n;
      const expired = await call('GET', `/v0/me/deposits/${signature}`, 'alice');
      assert.equal(expired.statusCode, 200); assert.equal(expired.json().deposit.status, 'EXPIRED');
      assert.equal(expired.json().deposit.failure, 'not_found_before_expiry');
      assert.equal(await paperCash('alice'), '500.000000000000000000');
      // The transfer is found finalized after expiry: 5 parallel polls credit it exactly once.
      chain.txs.set(signature, chain.txs.get(chain.transfer({ owner: wallets.alice, raw: 30n * ONE })));
      const found = await Promise.all(Array.from({ length: 5 }, () => call('GET', `/v0/me/deposits/${signature}`, 'alice')));
      for (const r of found) {
        assert.equal(r.statusCode, 200, r.body);
        assert.equal(r.json().deposit.status, 'CONFIRMED'); assert.equal(r.json().deposit.failure, null);
      }
      assert.equal(await paperCash('alice'), '530.000000000000000000');
      const credits = await pool.query("SELECT 1 FROM fund_events WHERE type = 'devnet_deposit_confirmed' AND payload->>'signature' = $1", [signature]);
      assert.equal(credits.rowCount, 1);
      assert.equal((await call('GET', `/v0/me/deposits/${signature}`, 'alice')).json().deposit.status, 'CONFIRMED');
      assert.equal(await paperCash('alice'), '530.000000000000000000');
    });

    await t.test('a transfer that landed but is not finalized stays pending past expiry, then credits', async () => {
      const signature = fakeSignature();
      chain.landed.set(signature, 'confirmed'); // Seen at confirmed; finalization (or the RPC node) lags.
      const pending = await call('POST', '/v0/me/deposits', 'bob', { signature, amountUsdc: '15' });
      assert.equal(pending.statusCode, 202);
      await pool.query("UPDATE token_deposits SET created_at = now() - interval '10 minutes' WHERE signature = $1", [signature]);
      chain.height += 1_000n;
      const lagging = await call('GET', `/v0/me/deposits/${signature}`, 'bob');
      assert.equal(lagging.statusCode, 202); assert.equal(lagging.json().deposit.status, 'PENDING');
      chain.txs.set(signature, chain.txs.get(chain.transfer({ owner: wallets.bob, raw: 15n * ONE })));
      assert.equal((await call('GET', `/v0/me/deposits/${signature}`, 'bob')).json().deposit.status, 'CONFIRMED');
      assert.equal(await paperCash('bob'), '35.000000000000000000');
    });

    let fundId;
    await t.test('a deposit can join a Captain fund in the same transaction', async () => {
      assert.equal((await bootstrap('cap', wallets.cap)).statusCode, 200);
      const seed = chain.transfer({ owner: wallets.cap, raw: 1_000n * ONE });
      assert.equal((await call('POST', '/v0/me/deposits', 'cap', { signature: seed, amountUsdc: '1000' })).json().deposit.status, 'CONFIRMED');
      assert.equal((await call('POST', '/v0/captains', 'cap', { handle: 'devnetcap' })).statusCode, 201);
      const fund = await call('POST', '/v0/funds', 'cap', { name: 'Devnet fund' }, 'fund-key-0001');
      assert.equal(fund.statusCode, 201, fund.body); fundId = fund.json().id;
      const signature = chain.transfer({ owner: wallets.alice, raw: 100n * ONE });
      const r = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '100', fundId });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().deposit.status, 'CONFIRMED'); assert.equal(r.json().deposit.join.error, null);
      assert.ok(r.json().deposit.join.eventId);
      assert.equal(await paperCash('alice'), '530.000000000000000000');
      const positions = (await call('GET', '/v0/me/paper-positions', 'alice')).json().positions;
      assert.equal(positions[0].fundId, fundId); assert.equal(Number(positions[0].shares), 100);
      // The Captain cannot join its own fund. The payment still lands as paper cash.
      const own = chain.transfer({ owner: wallets.cap, raw: 5n * ONE });
      const captain = (await call('POST', '/v0/me/deposits', 'cap', { signature: own, amountUsdc: '5', fundId })).json().deposit;
      assert.equal(captain.status, 'CONFIRMED'); assert.equal(captain.join.error, 'captain_seed_fixed');
      assert.equal(await paperCash('cap'), '5.000000000000000000');
    });

    await t.test('withdraw sends once per idempotency key, even under parallel retries', async () => {
      const before = chain.sends.length;
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        call('POST', '/v0/me/withdrawals', 'alice', { amountUsdc: '200' }, 'withdraw-key-0001')));
      for (const r of results) assert.ok([201, 202].includes(r.statusCode), r.body);
      const ids = new Set(results.map(r => r.json().withdrawal.id));
      assert.equal(ids.size, 1);
      const [id] = ids;
      const status = (await call('GET', `/v0/me/withdrawals/${id}`, 'alice')).json().withdrawal;
      assert.equal(status.status, 'CONFIRMED'); assert.equal(status.amount, '200.000000');
      const sent = chain.sends.slice(before);
      assert.equal(new Set(sent.map(s => s.signature)).size, 1, 'one signature was ever broadcast');
      assert.equal(await paperCash('alice'), '330.000000000000000000');
      const conflict = await call('POST', '/v0/me/withdrawals', 'alice', { amountUsdc: '1' }, 'withdraw-key-0001');
      assert.equal(conflict.statusCode, 409);
      assert.equal((await call('POST', '/v0/me/withdrawals', 'alice', { amountUsdc: '999999' }, 'withdraw-key-0002')).json().error, 'insufficient_virtual_cash');
      assert.equal((await call('POST', '/v0/me/withdrawals', 'alice', { amountUsdc: '1', fundId }, 'withdraw-key-0003')).json().error, 'invalid_withdrawal');
      assert.equal((await call('GET', `/v0/me/withdrawals/${id}`, 'bob')).statusCode, 404);
    });

    await t.test('a dropped withdrawal is rebroadcast, re-signed only after expiry, and lands once', async () => {
      chain.dropSends = true;
      const signedBefore = chain.signed;
      const r = await call('POST', '/v0/me/withdrawals', 'alice', { amountUsdc: '30' }, 'withdraw-key-0004');
      assert.equal(r.statusCode, 202, r.body);
      const { id, signature: first } = r.json().withdrawal;
      assert.equal(r.json().withdrawal.status, 'PENDING');
      // Still inside the blockhash window: the same signed bytes go out again, nothing new is signed.
      const retry = (await call('GET', `/v0/me/withdrawals/${id}`, 'alice')).json().withdrawal;
      assert.equal(retry.signature, first); assert.equal(chain.signed, signedBefore + 1);
      // The first transaction can no longer land: a new one is signed and it lands.
      chain.height += 1_000n; chain.dropSends = false;
      const resent = (await call('GET', `/v0/me/withdrawals/${id}`, 'alice')).json().withdrawal;
      assert.notEqual(resent.signature, first); assert.equal(resent.attempts, 2); assert.equal(resent.lastError, 'blockhash_expired');
      const done = (await call('GET', `/v0/me/withdrawals/${id}`, 'alice')).json().withdrawal;
      assert.equal(done.status, 'CONFIRMED'); assert.equal(done.signature, resent.signature);
      assert.equal(chain.landed.get(first), undefined, 'the expired signature never landed');
      // A late-landing original is detected and nothing is signed again.
      chain.dropSends = true;
      const late = (await call('POST', '/v0/me/withdrawals', 'alice', { amountUsdc: '1' }, 'withdraw-key-0005')).json().withdrawal;
      chain.landed.set(late.signature, 'confirmed'); chain.wallets.set(wallets.alice, chain.wallets.get(wallets.alice) + ONE);
      const signed = chain.signed;
      assert.equal((await call('GET', `/v0/me/withdrawals/${late.id}`, 'alice')).json().withdrawal.status, 'CONFIRMED');
      assert.equal(chain.signed, signed); chain.dropSends = false;
    });

    await t.test('a fund exit withdraws its paper payout to the wallet', async () => {
      const r = await call('POST', '/v0/me/withdrawals', 'alice', { fundId, shares: '40' }, 'withdraw-key-0006');
      assert.equal(r.statusCode, 201, r.body);
      assert.equal(r.json().exit.virtualUsdc, '40.000000');
      assert.equal(r.json().withdrawal.amount, '40.000000'); assert.equal(r.json().withdrawal.status, 'CONFIRMED');
      assert.equal(await paperCash('alice'), '299.000000000000000000');
    });

    await t.test('withdrawals have a minimum of 1 token', async () => {
      const r = await call('POST', '/v0/me/withdrawals', 'alice', { amountUsdc: '0.999999' }, 'withdraw-key-min1');
      assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'amount_too_small');
      assert.equal(await paperCash('alice'), '299.000000000000000000');
    });

    const creations = async wallet =>
      (await pool.query('SELECT ata_creations FROM user_wallets WHERE address = $1', [wallet])).rows[0].ata_creations;

    await t.test('the treasury pays for a user token account at most 3 times', async () => {
      const wallet = wallets.gina = await newAddress();
      assert.equal((await bootstrap('gina', wallet)).json().signupGrant.status, 'CONFIRMED');
      assert.equal(await creations(wallet), 1, 'the grant created the first account');
      const deposit = chain.transfer({ owner: wallet, raw: 100n * ONE });
      assert.equal((await call('POST', '/v0/me/deposits', 'gina', { signature: deposit, amountUsdc: '100' })).json().deposit.status, 'CONFIRMED');
      // The user closes the token account after each payout. The treasury recreates it twice more.
      for (const n of [2, 3]) {
        chain.atas.delete(wallet);
        const r = await call('POST', '/v0/me/withdrawals', 'gina', { amountUsdc: '1' }, `gina-close-${n}`);
        assert.equal(r.statusCode, 201, r.body); assert.equal(chain.sends.at(-1).createAta, true);
        assert.equal(await creations(wallet), n);
      }
      chain.atas.delete(wallet);
      const refused = await call('POST', '/v0/me/withdrawals', 'gina', { amountUsdc: '1' }, 'gina-close-4');
      assert.equal(refused.statusCode, 409); assert.equal(refused.json().error, 'token_account_required');
      assert.match(refused.json().message, /Create the associated token account/);
      assert.equal(await paperCash('gina'), '98.000000000000000000');
      // With its own token account the user withdraws as before, and the transaction creates nothing.
      chain.atas.add(wallet);
      const own = await call('POST', '/v0/me/withdrawals', 'gina', { amountUsdc: '1' }, 'gina-own-1');
      assert.equal(own.statusCode, 201, own.body); assert.equal(chain.sends.at(-1).createAta, false);
      // The account is closed before a re-sign: the payout waits and no creation is signed.
      chain.dropSends = true;
      const late = (await call('POST', '/v0/me/withdrawals', 'gina', { amountUsdc: '1' }, 'gina-own-2')).json().withdrawal;
      assert.equal(late.status, 'PENDING');
      chain.atas.delete(wallet); chain.height += 1_000n; chain.dropSends = false;
      const waiting = (await call('GET', `/v0/me/withdrawals/${late.id}`, 'gina')).json().withdrawal;
      assert.equal(waiting.status, 'PENDING'); assert.equal(waiting.lastError, 'token_account_required');
      assert.equal(waiting.signature, late.signature);
      chain.atas.add(wallet);
      await call('GET', `/v0/me/withdrawals/${late.id}`, 'gina');
      const done = (await call('GET', `/v0/me/withdrawals/${late.id}`, 'gina')).json().withdrawal;
      assert.equal(done.status, 'CONFIRMED'); assert.equal(done.attempts, 2);
      assert.equal(chain.sends.at(-1).createAta, false);
      assert.equal(await creations(wallet), 3);
      assert.equal(await paperCash('gina'), '96.000000000000000000');
    });

    await t.test('withdrawals and deposit prepares are rate limited per user', async () => {
      const wallet = await newAddress();
      assert.equal((await bootstrap('hank', wallet)).statusCode, 200);
      const deposit = chain.transfer({ owner: wallet, raw: 50n * ONE });
      assert.equal((await call('POST', '/v0/me/deposits', 'hank', { signature: deposit, amountUsdc: '50' })).json().deposit.status, 'CONFIRMED');
      for (let i = 0; i < 10; i++) {
        const r = await call('POST', '/v0/me/withdrawals', 'hank', { amountUsdc: '1' }, `hank-withdraw-${i}`);
        assert.equal(r.statusCode, 201, r.body);
      }
      const limited = await call('POST', '/v0/me/withdrawals', 'hank', { amountUsdc: '1' }, 'hank-withdraw-10');
      assert.equal(limited.statusCode, 429); assert.equal(limited.json().error, 'rate_limited');
      assert.equal(await paperCash('hank'), '40.000000000000000000');
      // A retry of an accepted request still returns its first result, and other users are not limited.
      const replay = await call('POST', '/v0/me/withdrawals', 'hank', { amountUsdc: '1' }, 'hank-withdraw-0');
      assert.equal(replay.statusCode, 201, replay.body);
      assert.equal((await call('POST', '/v0/me/withdrawals', 'gina', { amountUsdc: '1' }, 'gina-after-hank')).statusCode, 201);
      // Withdrawals older than one hour no longer count.
      await pool.query(`UPDATE token_payouts SET created_at = now() - interval '61 minutes'
        WHERE user_id = (SELECT id FROM users WHERE auth_subject = 'did:privy:hank')`);
      assert.equal((await call('POST', '/v0/me/withdrawals', 'hank', { amountUsdc: '1' }, 'hank-withdraw-11')).statusCode, 201);

      // 25 parallel prepares from one user: exactly 20 pass.
      const prepares = await Promise.all(Array.from({ length: 25 }, () =>
        call('POST', '/v0/me/deposits/prepare', 'hank', { amountUsdc: '1' })));
      assert.equal(prepares.filter(r => r.statusCode === 200).length, 20);
      const rejected = prepares.filter(r => r.statusCode !== 200);
      assert.ok(rejected.every(r => r.statusCode === 429 && r.json().error === 'rate_limited'));
      assert.equal((await call('POST', '/v0/me/deposits/prepare', 'gina', { amountUsdc: '1' })).statusCode, 200);
    });

    await t.test('a legacy paper account converts its current cash once; a layer toggle grants nothing more', async () => {
      const wallet = await newAddress();
      delete process.env.USDG_MINT; // The account is created and trades while the layer is off.
      try {
        assert.equal(await paperCash('legacy'), '10000.000000000000000000');
        const join = await call('POST', `/v0/funds/${fundId}/joins`, 'legacy', { amountUsdc: '250' }, 'legacy-join-0001');
        assert.equal(join.statusCode, 201, join.body);
      } finally { process.env.USDG_MINT = chain.mint; }
      const signedBefore = chain.signed;
      const first = await bootstrap('legacy', wallet);
      assert.equal(first.statusCode, 200, first.body);
      const grant = first.json().signupGrant;
      assert.equal(grant.amount, '9750.000000', 'the grant equals the current paper cash, not SIGNUP_GRANT');
      assert.equal(grant.status, 'CONFIRMED');
      assert.equal(await paperCash('legacy'), '0.000000000000000000');
      assert.equal(await chain.balance(wallet), 9_750n * ONE);
      const again = await call('POST', '/v0/me/withdrawals', 'legacy', { amountUsdc: '1' }, 'legacy-withdraw-1');
      assert.equal(again.statusCode, 422); assert.equal(again.json().error, 'insufficient_virtual_cash');
      // The layer goes off and on again: no paper grant, no second mint.
      delete process.env.USDG_MINT;
      try { assert.equal(await paperCash('legacy'), '0.000000000000000000'); }
      finally { process.env.USDG_MINT = chain.mint; }
      const retry = (await bootstrap('legacy', wallet)).json();
      assert.equal(retry.signupGrant.id, grant.id);
      assert.equal(chain.signed, signedBefore + 1, 'one conversion was ever signed');
      assert.equal(chain.landedFor(wallet, 'mint').length, 1);
      const payouts = await pool.query(`SELECT p.kind, p.amount_raw::text FROM token_payouts p
        JOIN users u ON u.id = p.user_id WHERE u.auth_subject = 'did:privy:legacy'`);
      assert.deepEqual(payouts.rows, [{ kind: 'SIGNUP_GRANT', amount_raw: '9750000000' }]);
      const conversion = await pool.query("SELECT payload FROM fund_events WHERE type = 'devnet_paper_converted' AND payload->>'wallet' = $1", [wallet]);
      assert.equal(conversion.rowCount, 1); assert.equal(conversion.rows[0].payload.minted, '9750.000000');
      // A user with no cash but with ledger history gets no grant at all.
      delete process.env.USDG_MINT;
      try {
        const all = await call('POST', `/v0/funds/${fundId}/joins`, 'spent', { amountUsdc: '10000' }, 'spent-join-0001');
        assert.equal(all.statusCode, 201, all.body);
      } finally { process.env.USDG_MINT = chain.mint; }
      const spent = (await bootstrap('spent', await newAddress())).json();
      assert.equal(spent.signupGrant, null);
    });

    await t.test('10 parallel status polls on a slow chain do not block other routes', async () => {
      chain.dropSends = true;
      const pending = (await call('POST', '/v0/me/withdrawals', 'gina', { amountUsdc: '1' }, 'gina-slow-1')).json().withdrawal;
      assert.equal(pending.status, 'PENDING');
      chain.slowMs = 1_500;
      try {
        const polls = Promise.all(Array.from({ length: 10 }, () => call('GET', `/v0/me/withdrawals/${pending.id}`, 'gina')));
        await sleep(300); // The polls now wait on the chain.
        const started = Date.now();
        const other = await call('GET', '/v0/me', 'bob');
        const elapsed = Date.now() - started;
        assert.equal(other.statusCode, 200, other.body);
        assert.ok(elapsed < 1_000, `an unrelated paper route took ${elapsed} ms`);
        for (const r of await polls) assert.equal(r.statusCode, 200, r.body);
      } finally { chain.slowMs = 0; chain.dropSends = false; }
      await call('GET', `/v0/me/withdrawals/${pending.id}`, 'gina');
      assert.equal((await call('GET', `/v0/me/withdrawals/${pending.id}`, 'gina')).json().withdrawal.status, 'CONFIRMED');
    });

    await t.test('balance shows the on-chain wallet and the paper ledger; the ledger balances', async () => {
      const r = await call('GET', '/v0/me/token-balance', 'alice');
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json();
      assert.equal(body.wallet, wallets.alice); assert.equal(body.token.label, 'Test USDC (devnet)');
      // Fake wallet balance counts only backend sends: grant 10000 + withdrawals 200 + 30 + 1 + 40.
      assert.equal(body.onchain.amount, '10271.000000');
      assert.equal(body.paper.cash.value, '299.000000000000000000');
      assert.equal(body.paper.positions[0].shares.startsWith('60'), true);
      const unbalanced = await pool.query(`SELECT e.event_id FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        GROUP BY e.event_id, a.asset_id HAVING SUM(e.amount) <> 0`);
      assert.equal(unbalanced.rowCount, 0);
      const users = await pool.query(`SELECT u.paper_cash::text, COALESCE(SUM(e.amount), 0)::text AS ledger FROM users u
        LEFT JOIN ledger_accounts a ON a.owner_type = 'USER' AND a.owner_id = u.id::text AND a.asset_id = 'USDC'
        LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY u.id`);
      for (const u of users.rows) assert.equal(Number(u.paper_cash), Number(u.ledger));
    });
  } finally {
    await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    delete process.env.USDG_MINT;
  }
});

test('the token layer refuses mainnet, other clusters and mints it does not control', async () => {
  const mint = await newAddress(); const authority = await generateKeyPairSigner();
  assert.throws(() => assertNotMainnetUrl('https://api.mainnet-beta.solana.com'), /mainnet/);
  assert.throws(() => assertNotMainnetUrl('https://mainnet.helius-rpc.com/?api-key=x'), /mainnet/);
  assert.doesNotThrow(() => assertNotMainnetUrl('https://api.devnet.solana.com'));
  await assert.rejects(loadTokenConfig({ USDG_MINT: mint, DEVNET_RPC_URL: 'https://api.mainnet-beta.solana.com' }), /mainnet/);
  assert.throws(() => assertDevnetGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'), /not Solana devnet/);
  assert.doesNotThrow(() => assertDevnetGenesis(DEVNET_GENESIS_HASH));
  assert.throws(() => assertOwnedMint(null, authority.address), /does not exist/);
  assert.throws(() => assertOwnedMint({ decimals: 9, mintAuthority: authority.address }, authority.address), /6 decimals/);
  assert.throws(() => assertOwnedMint({ decimals: 6, mintAuthority: mint }, authority.address), /does not control/);
  assert.throws(() => assertOwnedMint({ decimals: 6, mintAuthority: null }, authority.address), /does not control/);
  assert.doesNotThrow(() => assertOwnedMint({ decimals: 6, mintAuthority: authority.address }, authority.address));
  assert.equal(await loadTokenConfig({}), null, 'the layer is off without USDG_MINT');
  const secret = 'x'.repeat(50);
  await assert.rejects(parseKeypair('TREASURY', secret), e => !e.message.includes(secret));
  await assert.rejects(parseKeypair('TREASURY', JSON.stringify(Array(64).fill(7))), /not a valid/);
  await assert.rejects(loadTokenConfig({ USDG_MINT: mint }), /MINT_AUTHORITY is required/);
  process.env.USDG_MINT = mint;
  try {
    const other = await FakeChain.create();
    assert.throws(() => createApp(null, { token: { chain: other, signupGrantRaw: ONE } }), /no other mint/);
    assert.throws(() => createApp(null), /no other mint/);
  } finally { delete process.env.USDG_MINT; }
  const unconfigured = await FakeChain.create();
  assert.throws(() => createApp(null, { token: { chain: unconfigured, signupGrantRaw: ONE } }), /no other mint/);
});

// Recorded with getTransaction (finalized, jsonParsed) from devnet. Public data, no secrets.
const SIG = {
  grant: '2HVnreyBcUKbxDoQbmtfVovWp6cuZicRFjtVEcD7yA724i9pipNpy3K2wvSdxuNtUaneXpgfzmudNdZKi8bTJKWh',
  deposit: '5e8SihbnDqrJbCnpm8vm71K8ait2wWNZ9W5YwJ7pe8LRivMT3uDLQePZZSWwTPgSzhvBHYiHwez8xDVUAEKmBikz',
  withdraw: 'kzQSZk1oxaR422AJLETLrBqhWeeXaPyG6ep3wKCzDpL6J7ZFPuqdThfcNhgfQAcKu24GU3nP7fHretaUgsmDQjj',
};
const LIVE = {
  mint: 'AWVdAVJnMAwJ2NozuRV8htYzECfRzekiE1MYxwJCnD2a', treasuryAta: '3j3jUX9ybhVXV3PL1ru1kBD6qKjtPUG8ia4oCEegdRGU',
  treasury: 'FVziZA7YFSB5RGVXjj89d9oZs3T9LM8pw8yMRTvXkpSS', wallet: '9MPNYHz8G1tjMRMjccyk8yKyGUtCK1xdsZYgt7doohx8',
  userAta: '2eKX1bvZLLZgrvGaxeDBZzH7pRvTZkJ7eN7iPUdC8c5s',
};
const recorded = async name => JSON.parse(await readFile(new URL(`./fixtures/devnet-tx-${name}.json`, import.meta.url), 'utf8'));
const requests = [];
const rpcReturning = result => createSolanaRpcFromTransport(async ({ payload }) => {
  requests.push(payload);
  return { jsonrpc: '2.0', id: payload.id, result };
});
const observeRecorded = (result, signature = SIG.deposit) => observeTransaction(rpcReturning(result), signature);

test('observe parses recorded devnet transactions; the deposit check rejects mutated ones', async () => {
  const deposit = await recorded('deposit');
  const parsed = await observeRecorded(deposit);
  assert.deepEqual(parsed.instructions, [`${TOKEN_PROGRAM_ADDRESS}:transferChecked`]);
  assert.deepEqual(parsed.transfers, [{ source: LIVE.userAta, destination: LIVE.treasuryAta, mint: LIVE.mint, authority: LIVE.wallet, amount: 250n * ONE }]);
  assert.equal(parsed.innerInstructions, 0); assert.equal(parsed.failed, false);
  assert.deepEqual(parsed.balances, [
    { account: LIVE.userAta, mint: LIVE.mint, owner: LIVE.wallet, pre: 10_000n * ONE, post: 9_750n * ONE },
    { account: LIVE.treasuryAta, mint: LIVE.mint, owner: LIVE.treasury, pre: 1_000_000n * ONE, post: 1_000_250n * ONE },
  ]);
  assert.equal(requests[0].method, 'getTransaction');
  // Kit leaves out a commitment equal to the RPC default, finalized. "confirmed" would be sent.
  assert.equal(requests[0].params[1].commitment ?? 'finalized', 'finalized', 'deposits credit only at finalized');
  assert.equal(requests[0].params[1].encoding, 'jsonParsed');
  const expected = { mint: LIVE.mint, treasuryAta: LIVE.treasuryAta, wallet: LIVE.wallet, amountRaw: 250n * ONE };
  assert.equal(depositFailure(parsed, expected), null, 'the live deposit passes');
  assert.equal(depositFailure(parsed, { ...expected, amountRaw: 251n * ONE }), 'wrong_amount');
  assert.equal(depositFailure(parsed, { ...expected, treasuryAta: LIVE.userAta }), 'wrong_destination');

  const grant = await observeRecorded(await recorded('grant'), SIG.grant);
  assert.deepEqual(grant.instructions, ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL:createIdempotent', `${TOKEN_PROGRAM_ADDRESS}:mintToChecked`]);
  assert.deepEqual(grant.transfers, []); assert.ok(grant.innerInstructions > 0);
  assert.equal(depositFailure(grant, { ...expected, amountRaw: 10_000n * ONE }), 'unexpected_instruction');
  const withdraw = await observeRecorded(await recorded('withdraw'), SIG.withdraw);
  assert.deepEqual(withdraw.transfers, [{ source: LIVE.treasuryAta, destination: LIVE.userAta, mint: LIVE.mint, authority: LIVE.treasury, amount: 100n * ONE }]);
  assert.equal(depositFailure(withdraw, { ...expected, amountRaw: 100n * ONE }), 'unexpected_instruction');

  const other = await newAddress();
  const mutate = change => { const copy = structuredClone(deposit); change(copy); return observeRecorded(copy); };
  const swap = (from, to) => observeRecorded(JSON.parse(JSON.stringify(deposit).replaceAll(from, to)));
  const transferIx = deposit.transaction.message.instructions[0];
  const cases = [
    ['wrong mint', await swap(LIVE.mint, other), 'wrong_mint'],
    ['wrong owner', await swap(LIVE.wallet, other), 'wrong_owner'],
    ['extra transfer back to the source', await mutate(tx => tx.transaction.message.instructions.push({ ...transferIx,
      parsed: { ...transferIx.parsed, info: { ...transferIx.parsed.info, source: LIVE.treasuryAta, destination: LIVE.userAta, authority: LIVE.treasury } } })),
    'unexpected_instruction'],
    ['inner instruction', await mutate(tx => { tx.meta.innerInstructions = [{ index: 0, instructions: [{ ...transferIx, stackHeight: 2 }] }]; }),
      'unexpected_instruction'],
    ['failed', await mutate(tx => { tx.meta.err = { InstructionError: [0, { Custom: 1 }] }; }), 'transaction_failed'],
  ];
  for (const [name, tx, failure] of cases) assert.equal(depositFailure(tx, expected), failure, name);
  const withBudget = await mutate(tx => tx.transaction.message.instructions.unshift(
    { programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: 'Fj2Eoy', stackHeight: null }));
  assert.equal(depositFailure(withBudget, expected), null, 'compute budget instructions are allowed');
  assert.equal(await observeRecorded(null), null, 'a transaction the cluster has not finalized is null');
});

test('every RPC request is aborted after the timeout', async () => {
  const hang = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const keepAlive = setTimeout(() => {}, 5_000); // AbortSignal.timeout does not keep the event loop alive.
  try {
    const started = Date.now();
    await assert.rejects(withTimeout(hang, 50)({ payload: {} }), e => e.name === 'TimeoutError');
    await assert.rejects(observeTransaction(createSolanaRpcFromTransport(withTimeout(hang, 50)), SIG.deposit));
    assert.ok(Date.now() - started < 1_000);
  } finally { clearTimeout(keepAlive); }
});

test('DEV_ALLOW_UNVERIFIED_WALLET needs a localhost or devnet RPC and warns at startup', async () => {
  const secretKey = () => {
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    return JSON.stringify([...Buffer.from(jwk.d, 'base64url'), ...Buffer.from(jwk.x, 'base64url')]);
  };
  const env = { USDG_MINT: await newAddress(), MINT_AUTHORITY: secretKey(), TREASURY: secretKey(), DEV_ALLOW_UNVERIFIED_WALLET: '1' };
  await assert.rejects(loadTokenConfig({ ...env, DEVNET_RPC_URL: 'https://rpc.example.com' }), /DEV_ALLOW_UNVERIFIED_WALLET=1 is refused/);
  const warnings = []; const warn = console.warn; console.warn = message => warnings.push(message);
  try {
    for (const url of ['https://api.devnet.solana.com', 'http://127.0.0.1:8899', 'http://localhost:8899']) {
      assert.equal((await loadTokenConfig({ ...env, DEVNET_RPC_URL: url })).allowUnverifiedWallet, true);
    }
    assert.equal((await loadTokenConfig({ ...env, DEV_ALLOW_UNVERIFIED_WALLET: undefined })).allowUnverifiedWallet, false);
  } finally { console.warn = warn; }
  assert.equal(warnings.length, 3); assert.match(warnings[0], /NOT verified/);
});
