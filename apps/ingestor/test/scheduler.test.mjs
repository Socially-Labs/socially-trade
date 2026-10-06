import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Redis } from "ioredis";
import { JupiterScheduler } from "../dist/scheduler.js";
import { JupiterClient, JupiterClientError } from "../dist/client.js";
import { JupiterHttpError, SOL_MINT } from "@socially/market-data";

const accounts = Array.from({ length: 10 }, (_, i) => ({ id: `JUP_ACC_${i + 1}`, key: `fixture-${i + 1}`, organisation: `org-${i + 1}` }));
const prefix = account => `socially:{jupiter:${createHash("sha256").update(account.organisation).digest("hex")}}`;
const provider = "socially:{jupiter:provider}:price-v3";
let server; let redis; let directory; let serverError;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "socially-jupiter-test-"));
  const socket = join(directory, "redis.sock");
  server = spawn("redis-server", ["--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no", "--dir", directory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  server.stdout.on("data", chunk => { output += chunk; }); server.stderr.on("data", chunk => { output += chunk; });
  server.on("error", error => { serverError = error; });
  for (let i = 0; i < 100 && !output.toLowerCase().includes("ready to accept connections"); i++) {
    if (serverError || server.exitCode !== null) throw new Error(`Test Redis failed: ${serverError?.message ?? output}`);
    await delay(20);
  }
  if (!output.toLowerCase().includes("ready to accept connections")) throw new Error("Test Redis startup timed out");
  redis = new Redis(socket, { lazyConnect: true, retryStrategy: () => null, commandTimeout: 1_000, maxRetriesPerRequest: 0 });
  redis.on("error", () => {}); await redis.connect();
});
beforeEach(async () => { await redis.flushdb(); });
after(async () => {
  redis?.disconnect();
  if (server && server.exitCode === null && !serverError) {
    const stopped = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await stopped;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("rotates fairly across all ten organisations and isolates their pacing", async () => {
  const scheduler = new JupiterScheduler(redis, accounts); const ids = [];
  for (let i = 0; i < 10; i++) { const permit = await scheduler.next(); assert.ok("account" in permit); ids.push(permit.account.id); await scheduler.release(permit); }
  assert.deepEqual(ids, accounts.map(account => account.id));
  const blocked = await scheduler.next(); assert.ok(blocked.waitMs > 0 && blocked.waitMs <= 1_250);
  for (const account of accounts) assert.equal(await redis.zcard(`${prefix(account)}:window`), 1);
});

test("two replicas cannot acquire overlapping requests for one organisation", async () => {
  const left = new JupiterScheduler(redis, [accounts[0]]); const right = new JupiterScheduler(redis, [accounts[0]]);
  const permits = await Promise.all([left.next(), right.next()]);
  assert.equal(permits.filter(permit => "account" in permit).length, 1);
  assert.equal(await redis.zcard(`${prefix(accounts[0])}:window`), 1);
  const permit = permits.find(permit => "account" in permit);
  await left.release({ ...permit, token: "incorrect-owner" });
  assert.equal(await redis.get(`${prefix(accounts[0])}:lease`), permit.token);
  await left.release(permit); assert.equal(await redis.exists(`${prefix(accounts[0])}:lease`), 0);
  assert.ok((await right.next()).waitMs > 0);
});

test("48-call sliding window blocks only its organisation, and expired requests leave the budget", async () => {
  const [seconds, micros] = await redis.time(); const now = Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000);
  const window = `${prefix(accounts[0])}:window`;
  await redis.zadd(window, ...Array.from({ length: 48 }, (_, i) => [now - 59_000 + i * 1_200, `request-${i}`]).flat());
  const single = new JupiterScheduler(redis, [accounts[0]]);
  assert.ok((await single.next()).waitMs > 0);
  const pooled = new JupiterScheduler(redis, accounts.slice(0, 2));
  const permit = await pooled.next(); assert.equal(permit.account.id, accounts[1].id); await pooled.release(permit);
  await redis.zadd(window, now - 60_001, "request-0");
  const recovered = await single.next(); assert.ok("account" in recovered); await single.release(recovered);
  assert.equal(await redis.zcard(window), 48);
});

test("429 honours absolute reset with margin and falls back without affecting another organisation", async () => {
  const scheduler = new JupiterScheduler(redis, accounts); const requested = [];
  const resetAt = Date.now() + 30_000;
  const client = new JupiterClient(scheduler, { fetchPrices: async key => {
    requested.push(key); if (key === accounts[0].key) throw new JupiterHttpError(429, resetAt); return new Map();
  } });
  await client.getPrices([SOL_MINT]);
  assert.deepEqual(requested, [accounts[0].key, accounts[1].key]);
  assert.ok(Number(await redis.get(`${prefix(accounts[0])}:blocked`)) >= resetAt + 250);
  assert.equal(await redis.exists(`${prefix(accounts[1])}:blocked`), 0);
  assert.equal(await redis.exists(`${provider}:blocked`), 0);
  assert.ok((await new JupiterScheduler(redis, [accounts[0]]).next()).waitMs >= 29_000);
});

test("missing 429 reset gets bounded cooldown; a later shorter cooldown cannot shorten it", async () => {
  const scheduler = new JupiterScheduler(redis, accounts); const permit = await scheduler.next();
  assert.ok(await scheduler.failed(permit, "rate_limit") >= 5_000);
  await scheduler.failed(permit, "rate_limit", Date.now() + 60_000);
  const until = await redis.get(`${prefix(permit.account)}:blocked`);
  await scheduler.failed(permit, "rate_limit", Date.now() - 100_000);
  assert.equal(await redis.get(`${prefix(permit.account)}:blocked`), until); await scheduler.release(permit);
});

test("invalid credentials are disabled for one hour and a rotated secret can recover the same slot", async () => {
  const scheduler = new JupiterScheduler(redis, accounts); const permit = await scheduler.next();
  await scheduler.failed(permit, "credential"); await scheduler.release(permit);
  const disabled = `${prefix(accounts[0])}:disabled:${createHash("sha256").update(accounts[0].key).digest("hex")}`;
  assert.ok(await redis.pttl(disabled) > 3_599_000);
  assert.ok((await new JupiterScheduler(redis, [accounts[0]]).next()).waitMs > 3_599_000);
  // The organisation's consumed quota survives secret rotation; let its last call age naturally in Redis time.
  const window = `${prefix(accounts[0])}:window`; const [member, score] = await redis.zrange(window, 0, 0, "WITHSCORES");
  await redis.zadd(window, Number(score) - 2_000, member);
  const replacement = new JupiterScheduler(redis, [{ ...accounts[0], key: "replacement-secret" }]);
  const recovered = await replacement.next(); assert.ok("account" in recovered); await replacement.release(recovered);
  assert.equal(await redis.zcard(window), 2);
});

test("legacy keys from one organisation share both quota and 429 cooldown", async () => {
  const legacy = [{ ...accounts[0], organisation: "shared" }, { ...accounts[1], organisation: "shared" }];
  const scheduler = new JupiterScheduler(redis, legacy); const permit = await scheduler.next();
  await scheduler.failed(permit, "rate_limit", Date.now() + 30_000); await scheduler.release(permit);
  assert.ok((await scheduler.next()).waitMs > 29_000);
  assert.equal(await redis.zcard(`${prefix(legacy[0])}:window`), 1);
});

test("three distinct transient failures open a shared breaker, then healthy traffic recovers", async () => {
  const scheduler = new JupiterScheduler(redis, accounts); let requests = 0;
  const client = new JupiterClient(scheduler, { fetchPrices: async () => { requests++; throw new JupiterHttpError(503, null); } });
  await assert.rejects(client.getPrices([SOL_MINT]), JupiterClientError);
  assert.equal(requests, 3); assert.ok(await redis.pttl(`${provider}:blocked`) > 9_000);
  const replica = new JupiterScheduler(redis, accounts); assert.ok((await replica.next()).waitMs > 9_000);
  // Expire just the breaker to test recovery without sleeping through the production cooldown.
  await redis.pexpire(`${provider}:blocked`, 1); await delay(10);
  const healthy = new JupiterClient(replica, { fetchPrices: async () => new Map() });
  await healthy.getPrices([SOL_MINT]); assert.equal(await redis.exists(`${provider}:failures`), 0);
});

test("repeated failures on one organisation cannot open the multi-organisation breaker", async () => {
  const scheduler = new JupiterScheduler(redis, accounts); const permit = await scheduler.next();
  for (let i = 0; i < 3; i++) await scheduler.failed(permit, "transient");
  assert.equal(await redis.exists(`${provider}:blocked`), 0); await scheduler.release(permit);
});

test("token permissions are scoped but price/token calls share organisation pacing and quota", async () => {
  const tokens = new JupiterScheduler(redis, [accounts[0]], "tokens-v2"), prices = new JupiterScheduler(redis, [accounts[0]]);
  const permit = await tokens.next(); await tokens.failed(permit, "permission"); await tokens.release(permit);
  assert.ok((await tokens.next()).waitMs > 3_599_000);
  assert.ok((await prices.next()).waitMs > 0, "Token request consumed shared price budget");
  const window = `${prefix(accounts[0])}:window`, [member, score] = await redis.zrange(window,0,0,"WITHSCORES");
  await redis.zadd(window,Number(score)-2000,member);
  const pricePermit = await prices.next(); assert.ok("account" in pricePermit); await prices.release(pricePermit);
  assert.equal(await redis.zcard(window),2);
});

test("metadata/search cannot exhaust remaining price capacity when only one organisation is healthy", async () => {
  const [seconds, micros] = await redis.time(), now = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  const window = `${prefix(accounts[0])}:window`;
  await redis.zadd(window, ...Array.from({ length: 28 }, (_, i) => [now - 59_000 + i * 1_200, `shared-${i}`]).flat());
  const metadata = new JupiterScheduler(redis, [accounts[0]], "tokens-v2");
  assert.ok((await metadata.next()).waitMs > 0);
  assert.equal(await redis.zcard(window), 28, "Denied metadata consumes no quota");
  const prices = new JupiterScheduler(redis, [accounts[0]]), permit = await prices.next();
  assert.ok("account" in permit); await prices.release(permit);
  assert.equal(await redis.zcard(window), 29);
});
