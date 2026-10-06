import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { LogCollector } from '@socially/logging';

test('log viewer serves CSP protected UI, validates filters, and rejects remote anonymous access', async t => {
  const saved = { NODE_ENV: process.env.NODE_ENV, ADMIN_LOGS_TOKEN: process.env.ADMIN_LOGS_TOKEN, ADMIN_LOGS_ENABLED: process.env.ADMIN_LOGS_ENABLED };
  process.env.NODE_ENV = 'development'; delete process.env.ADMIN_LOGS_TOKEN; delete process.env.ADMIN_LOGS_ENABLED;
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const logs = new LogCollector('api', { redisUrl: null }); const app = createApp(null, { logs }); t.after(() => app.close());
  logs.log('warn', 'Jupiter timeout', { job: 'test', token: 'secret-value' }, 'req-log-test');
  const page = await app.inject('/admin/logs'); assert.equal(page.statusCode, 200); assert.equal(page.headers['cache-control'], 'no-store');
  for (const tag of ['script', 'style']) {
    const content = page.body.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'))[1];
    assert.ok(page.headers['content-security-policy'].includes(createHash('sha256').update(content).digest('base64')));
  }
  const local = await app.inject({ url: '/admin/logs/data?level=warn&q=timeout&requestId=req-log-test', remoteAddress: '127.0.0.1' });
  assert.equal(local.statusCode, 200); assert.equal(local.json().entries.length, 1); assert.ok(!local.body.includes('secret-value'));
  for (const options of [ { remoteAddress: '192.0.2.1' }, { remoteAddress: '127.0.0.1', headers: { host: 'attacker.example' } }, { remoteAddress: '127.0.0.1', headers: { origin: 'https://attacker.example' } } ]) {
    assert.ok([401, 403].includes((await app.inject({ url: '/admin/logs/data', ...options })).statusCode));
  }
  for (const query of ['level=invalid', 'service=postgres', 'since=not-a-date', 'limit=2001', 'unexpected=yes', 'service=api&service=worker']) {
    assert.equal((await app.inject('/admin/logs/data?' + query)).statusCode, 400, query);
  }
  process.env.NODE_ENV = 'production';
  assert.equal((await app.inject('/admin/logs/data')).statusCode, 401);
  process.env.ADMIN_LOGS_TOKEN = 'test-admin-token';
  assert.equal((await app.inject('/admin/logs/data')).statusCode, 401);
  assert.equal((await app.inject({ url: '/admin/logs/data', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  const authenticated = await app.inject({ url: '/admin/logs/data', headers: { authorization: 'Bearer test-admin-token' } });
  assert.equal(authenticated.statusCode, 200);
  assert.equal(authenticated.json().retained, 1, 'The viewer must not log its own polling or tokens');
});

test('explicitly disabling admin logs removes both routes', async t => {
  const previous = process.env.ADMIN_LOGS_ENABLED; process.env.ADMIN_LOGS_ENABLED = 'false';
  t.after(() => { previous === undefined ? delete process.env.ADMIN_LOGS_ENABLED : process.env.ADMIN_LOGS_ENABLED = previous; });
  const app = createApp(null, { logs: new LogCollector('api', { redisUrl: null }) }); t.after(() => app.close());
  assert.equal((await app.inject('/admin/logs')).statusCode, 404);
  assert.equal((await app.inject('/admin/logs/data')).statusCode, 404);
});
