import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { LogCollector, captureConsole, redact } from '../dist/index.js';

test('redacts nested credentials, environment secrets, URLs, JWTs, and circular errors', () => {
  const details = { password: 'password-value', auth: { authorization: 'Bearer access' }, token: 'access',
    request: 'https://host/path?api_key=1234&key=5678', connection: 'postgres://name:password@host/db',
    error: new Error('secret-value Bearer abcdef eyJhbGciOiJIUzI1NiJ9.e30.signature') };
  details.circular = details;
  const result = redact(details, ['secret-value']);
  const text = JSON.stringify(result);
  for (const secret of ['password-value', 'Bearer access', 'secret-value', 'Bearer abcdef', 'eyJhbGci', 'name:password', '1234', '5678']) assert.ok(!text.includes(secret), secret);
  assert.equal(result.circular, '[CIRCULAR]');
  assert.ok(result.error.stack.includes('[REDACTED]'));
});

test('keeps bounded newest entries and applies severity, search, request and time filters', async t => {
  const logs = new LogCollector('api', { redisUrl: null }); t.after(() => logs.close());
  for (let i = 0; i < 2_010; i++) logs.log('info', 'Event ' + i, { index: i });
  logs.log('error', 'Job failed', { context: 'timeout' }, 'req-test');
  const result = await logs.read({ level: 'error', search: 'TIMEOUT', requestId: 'req-test' });
  assert.equal(result.retained, 2_000); assert.equal(result.total, 1); assert.equal(result.transport, 'local');
  assert.equal(result.entries[0].message, 'Job failed'); assert.equal(result.errors, 1);
  assert.equal((await logs.read({ service: 'worker' })).total, 0);
  assert.equal((await logs.read({ since: Date.now() + 5_000 })).total, 0);
  assert.equal((await logs.read({ limit: 3 })).entries.length, 3);
  assert.equal((await logs.read({ limit: 1 })).entries[0].message, 'Job failed');
});

test('preserves Fastify/Pino severity and request context while redacting', async t => {
  const logs = new LogCollector('api', { redisUrl: null }); t.after(() => logs.close());
  logs.stream.write(JSON.stringify({ level: 40, msg: 'Slow request', reqId: 'req-7', req: { url: '/v0/me?token=secret', headers: { authorization: 'Bearer hidden' } } }) + '\n');
  const { entries } = await logs.read();
  assert.equal(entries[0].level, 'warn'); assert.equal(entries[0].requestId, 'req-7');
  assert.ok(!JSON.stringify(entries).includes('hidden')); assert.ok(!JSON.stringify(entries).includes('token=secret'));
});

test('captures and restores executable console diagnostics including Error context', async t => {
  const logs = new LogCollector('worker', { redisUrl: null }); t.after(() => logs.close());
  const original = console.warn;
  const restore = captureConsole(logs);
  try { console.warn('Worker diagnostic', { error: new Error('job failed'), password: 'hidden' }); }
  finally { restore(); }
  assert.equal(console.warn, original);
  const { entries } = await logs.read();
  assert.equal(entries[0].service, 'worker'); assert.equal(entries[0].level, 'warn');
  assert.equal(entries[0].details.arguments[1].error.message, 'job failed');
  assert.equal(entries[0].details.arguments[1].password, '[REDACTED]');
});

test('caps oversized diagnostics and tolerates throwing getters', async t => {
  const logs = new LogCollector('ingestor', { redisUrl: null }); t.after(() => logs.close());
  logs.log('error', 'Large diagnostic', Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['field' + i, 'x'.repeat(10_000)])));
  const broken = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('bad getter'); } });
  assert.doesNotThrow(() => logs.log('warn', 'Broken diagnostic', broken));
  const { entries } = await logs.read();
  assert.ok(JSON.stringify(entries.find(entry => entry.message === 'Large diagnostic')).length < 8_192);
  assert.equal(entries.find(entry => entry.message === 'Broken diagnostic').details, '[UNSERIALIZABLE]');
});

test('aggregates three independent service collectors, deduplicates and bounds Redis retention', { skip: !process.env.LOG_TEST_REDIS_URL }, async t => {
  const url = process.env.LOG_TEST_REDIS_URL, key = 'socially:test:logs:' + randomUUID();
  const redis = new Redis(url);
  const collectors = ['api', 'worker', 'ingestor'].map(service => new LogCollector(service, { redisUrl: url, key }));
  t.after(async () => { await Promise.all(collectors.map(logs => logs.close())); await redis.del(key); redis.disconnect(); });
  await redis.ping();
  await new Promise(resolve => setTimeout(resolve, 150));
  collectors[0].log('info', 'API ready'); collectors[1].log('error', 'Worker error', { job: 'orders' }); collectors[2].log('warn', 'Ingestor cooling down');
  await Promise.all(collectors.map(logs => logs.flush()));
  const result = await collectors[0].read();
  assert.equal(result.transport, 'redis'); assert.equal(result.entries.length, 3);
  assert.deepEqual(new Set(result.entries.map(entry => entry.service)), new Set(['api', 'worker', 'ingestor']));
  assert.equal(result.errors, 1); assert.equal(result.warnings, 1);
  assert.ok((await redis.ttl(key)) > 86_000);
  for (let i = 0; i < 2_100; i++) collectors[1].log('info', 'Worker job ' + i);
  for (let i = 0; i < 20; i++) await collectors[1].flush();
  assert.equal(await redis.llen(key), 2_000);
  assert.equal((await collectors[0].read()).retained, 2_000);
});
