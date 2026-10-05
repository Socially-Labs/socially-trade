import { configurePrivyFixture } from './privy-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { generateKeyPairSigner } from '@solana/kit';
import { createApp } from '../dist/app.js';
import {
  assertDevnetGenesis, assertNotMainnetUrl, assertOwnedMint, DEVNET_GENESIS_HASH, loadTokenConfig, parseKeypair,
} from '../dist/token-chain.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeSignature = () => Array.from(randomBytes(88), b => B58[b % 58]).join('');
const newAddress = async () => (await generateKeyPairSigner()).address;
const ONE = 1_000_000n;

// In-memory stand-in for the TokenChain seam. Like a real cluster, one signature executes once.
class FakeChain {
  static async create() {
    const chain = new FakeChain();
    chain.mint = await newAddress(); chain.treasuryAta = await newAddress(); chain.otherMint = await newAddress();
    return chain;
  }
  height = 1_000n; txs = new Map(); landed = new Map(); sends = []; signed = 0; dropSends = false; wallets = new Map();
  async observe(signature) { return this.txs.get(signature) ?? null; }
  async status(signature) { return this.landed.get(signature) ?? 'missing'; }
  async blockHeight() { return this.height; }
  async signMint(owner, raw) { return this.sign('mint', owner, raw); }
  async signPayout(owner, raw) { return this.sign('payout', owner, raw); }
  sign(kind, owner, raw) {
    this.signed++;
    const signature = fakeSignature();
    return { signature, lastValidBlockHeight: this.height + 150n, wire: JSON.stringify({ signature, kind, owner, raw: String(raw) }) };
  }
  async send(wire) {
    const tx = JSON.parse(wire);
    this.sends.push(tx);
    if (this.dropSends || this.landed.has(tx.signature)) return;
    this.landed.set(tx.signature, 'confirmed');
    this.wallets.set(tx.owner, (this.wallets.get(tx.owner) ?? 0n) + BigInt(tx.raw));
  }
  landedFor(owner, kind) { return this.sends.filter(s => s.owner === owner && s.kind === kind && this.landed.get(s.signature) === 'confirmed')
    .filter((s, i, all) => all.findIndex(x => x.signature === s.signature) === i); }
  async prepareDeposit(owner, raw) {
    return { transaction: Buffer.from(JSON.stringify({ owner, raw: String(raw) })).toString('base64'), lastValidBlockHeight: this.height + 150n };
  }
  async balance(owner) { return this.wallets.get(owner) ?? 0n; }
  /** A confirmed user transfer, described by its token balance changes. */
  transfer({ owner, raw, sent = raw, mint = this.mint, destination = this.treasuryAta, failed = false }) {
    const signature = fakeSignature();
    this.txs.set(signature, { failed, balances: [
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
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 15 });
  const app = createApp(pool, { token: { chain, signupGrantRaw: 10_000n * ONE } });
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
      process.env.NODE_ENV = 'production';
      try {
        const blocked = await bootstrap('erin', await newAddress());
        assert.equal(blocked.statusCode, 503); assert.equal(blocked.json().error, 'wallet_verification_unconfigured');
      } finally { process.env.NODE_ENV = 'development'; }
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

    await t.test('an unseen signature stays pending, then expires and never credits', async () => {
      const signature = fakeSignature();
      const pending = await call('POST', '/v0/me/deposits', 'alice', { signature, amountUsdc: '30' });
      assert.equal(pending.statusCode, 202); assert.equal(pending.json().deposit.status, 'PENDING');
      assert.equal((await call('GET', `/v0/me/deposits/${signature}`, 'alice')).statusCode, 202);
      await pool.query("UPDATE token_deposits SET created_at = now() - interval '10 minutes' WHERE signature = $1", [signature]);
      const expired = await call('GET', `/v0/me/deposits/${signature}`, 'alice');
      assert.equal(expired.statusCode, 200); assert.equal(expired.json().deposit.status, 'EXPIRED');
      // The transfer lands after expiry: the terminal state does not change and nothing is credited.
      chain.txs.set(signature, chain.txs.get(chain.transfer({ owner: wallets.alice, raw: 30n * ONE })));
      assert.equal((await call('GET', `/v0/me/deposits/${signature}`, 'alice')).json().deposit.status, 'EXPIRED');
      assert.equal(await paperCash('alice'), '500.000000000000000000');
      const later = fakeSignature();
      await call('POST', '/v0/me/deposits', 'alice', { signature: later, amountUsdc: '30' });
      chain.txs.set(later, chain.txs.get(chain.transfer({ owner: wallets.alice, raw: 30n * ONE })));
      assert.equal((await call('GET', `/v0/me/deposits/${later}`, 'alice')).json().deposit.status, 'CONFIRMED');
      assert.equal(await paperCash('alice'), '530.000000000000000000');
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

    await t.test('balance shows the on-chain wallet and the paper ledger; the ledger balances', async () => {
      const r = await call('GET', '/v0/me/token-balance', 'alice');
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json();
      assert.equal(body.wallet, wallets.alice); assert.equal(body.token.label, 'USDG (devnet)');
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
