import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { Amount } from '../../../packages/domain/dist/index.js';

// A local JWKS server exercises production verification, without a managed provider or Pyth.
test('production JWT backend simulation with localhost JWKS', { timeout: 30_000 }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const wrongKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...await exportJWK(publicKey), kid: 'local-key', alg: 'RS256', use: 'sig' };
  let keyRequests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/jwks'); keyRequests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  process.env.NODE_ENV = 'production'; process.env.AUTH_ISSUER = issuer;
  process.env.AUTH_AUDIENCE = 'paper-api-test'; process.env.AUTH_JWKS_URL = issuer + '/jwks';
  process.env.DEV_AUTH_TOKEN = 'development-token-disabled-in-production';
  delete process.env.PYTH_API_KEY;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input);
    assert.equal(url.origin, issuer, 'No external provider requests are allowed');
    return originalFetch(input, options);
  };
  const schema = `auth_simulation_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  const { createApp } = await import('../dist/app.js');
  const app = createApp(pool); app.log.level = 'silent';
  const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
  const sign = async (claims = {}, key = privateKey) => new SignJWT({ sub: 'managed:alice', name: 'Alice',
    iss: issuer, aud: 'paper-api-test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-key' }).sign(key);
  const call = (token, extras = {}) => app.inject({ method: 'GET', url: '/v0/me', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extras } });
  let aliceId;
  try {
    for (const file of (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await t.test('valid signed tokens create one account and one budget despite concurrent retries', async () => {
      const token = await sign();
      const results = await Promise.all(Array.from({ length: 8 }, () => call(token)));
      assert.ok(results.every(r => r.statusCode === 200), results.map(r => r.body).join('\n'));
      aliceId = results[0].json().id;
      assert.ok(results.every(r => r.json().id === aliceId && new Amount(r.json().paperCash.value).eq('10000')));
      assert.equal((await pool.query("SELECT id FROM fund_events WHERE type='paper_budget_granted'")).rowCount, 1);
      assert.ok(keyRequests > 0, 'Verification fetched a real localhost JWKS document');
    });
    await t.test('missing, malformed and expired bearer tokens cannot create accounts', async () => {
      for (const token of [undefined, 'not-a-jwt', await sign({ exp: Math.floor(Date.now() / 1000) - 60 })]) {
        const result = await call(token); assert.equal(result.statusCode, 401, result.body);
      }
    });
    await t.test('issuer audience signature and future not-before claims are verified', async () => {
      for (const token of [await sign({ iss: 'https://wrong.example' }), await sign({ aud: 'other-api' }),
        await sign({}, wrongKey), await sign({ nbf: Math.floor(Date.now() / 1000) + 300 })]) {
        const result = await call(token); assert.equal(result.statusCode, 401, result.body);
      }
    });
    await t.test('missing subject and development credentials are rejected in production', async () => {
      for (const token of [await sign({ sub: undefined }), process.env.DEV_AUTH_TOKEN]) {
        const result = await call(token, { 'x-dev-subject': 'dev:admin' }); assert.equal(result.statusCode, 401, result.body);
      }
    });
    await t.test('development subject headers cannot impersonate a different JWT account', async () => {
      const result = await call(await sign(), { 'x-dev-subject': 'dev:admin' });
      assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().id, aliceId);
      assert.equal((await pool.query('SELECT auth_subject FROM users WHERE id=$1', [aliceId])).rows[0].auth_subject, 'managed:alice');
      assert.equal((await pool.query('SELECT id FROM users')).rowCount, 1);
    });
    await t.test('private performance record requires JWT and separates authenticated accounts', async () => {
      const anonymous = await app.inject({ method: 'GET', url: '/v0/me/paper-record' }); assert.equal(anonymous.statusCode, 401);
      for (const token of [await sign(), await sign({ sub: 'managed:bob', name: 'Bob' })]) {
        const r = await app.inject({ method: 'GET', url: '/v0/me/paper-record', headers: { authorization: `Bearer ${token}` } });
        assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json(), { mode: 'PAPER', records: [] });
      }
    });
    await t.test('invalid tokens leave no grants and every issued virtual amount balances', async () => {
      assert.equal((await pool.query('SELECT id FROM users')).rowCount, 2);
      assert.equal((await pool.query("SELECT id FROM fund_events WHERE type='paper_budget_granted'")).rowCount, 2);
      const result = await pool.query(`SELECT e.event_id,a.asset_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id
        GROUP BY e.event_id,a.asset_id HAVING SUM(e.amount)<>0`);
      assert.equal(result.rowCount, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
