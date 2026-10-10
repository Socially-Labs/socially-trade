import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JupiterClient, JupiterClientError } from "../dist/client.js";
import { loadJupiterAccounts } from "../dist/config.js";
import { JupiterDataError, JupiterHttpError, SOL_MINT } from "@socially/market-data";

const accounts = Array.from({ length: 10 }, (_, i) => ({ id: `JUP_ACC_${i + 1}`, key: `test-key-${i + 1}`, organisation: `org-${i + 1}` }));
const result = new Map([[SOL_MINT, { priceUsd: "150", blockId: 123, decimals: 9 }]]);
function fixture(overrides = {}) {
  const state = { failures: [], releases: [], successes: 0, acquisitions: 0 };
  const scheduler = {
    async next(excluded) {
      state.acquisitions++;
      const account = accounts.find(account => !excluded.has(account.id));
      return account ? { account, token: String(state.acquisitions) } : { waitMs: 10_000 };
    },
    async failed(permit, failure, resetAt) { state.failures.push({ accountId: permit.account.id, failure, resetAt }); return 5_000; },
    async release(permit) { state.releases.push(permit.account.id); },
    async succeeded() { state.successes++; },
    ...overrides,
  };
  return { scheduler, state };
}
const isCode = code => error => error instanceof JupiterClientError && error.code === code;

test('short pacing waits acquire a fresh permit without consuming an HTTP retry', async () => {
  const { scheduler, state } = fixture(); const next = scheduler.next;
  let permits = 0, requests = 0;
  scheduler.next = async (...args) => ++permits <= 2 ? { waitMs: 1 } : next(...args);
  const client = new JupiterClient(scheduler, { maxAttempts: 1, fetchPrices: async () => { requests++; return result; } });
  assert.equal(await client.getPrices([SOL_MINT]), result);
  assert.equal(requests, 1); assert.equal(permits, 3);
  assert.deepEqual(state.failures, []); assert.equal(state.releases.length, 1);
});

test('cancelling during a pacing wait never sends a provider request', async () => {
  const { scheduler } = fixture({ next: async () => ({ waitMs: 1000 }) });
  let requests = 0;
  const client = new JupiterClient(scheduler, { fetchPrices: async () => { requests++; return result; } });
  const abort = new AbortController(); const pending = client.getPrices([SOL_MINT], abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, isCode('cancelled')); assert.equal(requests, 0);
});

test("loads numbered accounts in numeric order, including gaps, without requiring legacy config", () => {
  const configured = loadJupiterAccounts({ JUP_ACC_10: " last ", JUP_ACC_2: "second", JUP_ACC_1: "first" });
  assert.deepEqual(configured.map(({ id, organisation }) => [id, organisation]),
    [["JUP_ACC_1", "default"], ["JUP_ACC_2", "default"], ["JUP_ACC_10", "default"]]);
  assert.equal(configured[2].key, "last");
  const grouped = loadJupiterAccounts({ JUP_ACC_1: 'one', JUP_ACC_2: 'two', JUPITER_ORGANISATION_ID: 'shared', JUP_ACC_2_ORGANISATION_ID: 'separate' });
  assert.deepEqual(grouped.map(a => a.organisation), ['shared', 'separate']);
});

test("rejects empty, duplicate and ambiguous configuration without exposing keys", () => {
  assert.throws(() => loadJupiterAccounts({}), /at least one/);
  assert.throws(() => loadJupiterAccounts({ JUPITER_API_KEYS: "secret" }), /ORGANISATION_ID/);
  for (const env of [{ JUP_ACC_1: "secret-value", JUP_ACC_2: "secret-value" },
    { JUP_ACC_1: "secret-value", JUPITER_API_KEYS: "another" }]) {
    assert.throws(() => loadJupiterAccounts(env), error => !error.message.includes("secret-value"));
  }
  const legacy = loadJupiterAccounts({ JUPITER_API_KEYS: "a,b", JUPITER_ORGANISATION_ID: "shared-org" });
  assert.deepEqual(legacy.map(account => account.organisation), ["shared-org", "shared-org"]);
});

for (const [status, failure] of [[429, "rate_limit"], [401, "credential"], [403, "credential"], [503, "transient"], [408, "transient"]]) {
  test(`HTTP ${status} falls back to another account and returns success`, async () => {
    const { scheduler, state } = fixture(); const keys = []; const events = [];
    const resetAt = Date.now() + 60_000;
    const client = new JupiterClient(scheduler, {
      onFailure: event => events.push(event),
      fetchPrices: async key => { keys.push(key); if (keys.length === 1) throw new JupiterHttpError(status, resetAt); return result; },
    });
    assert.equal(await client.getPrices([SOL_MINT]), result);
    assert.deepEqual(keys, [accounts[0].key, accounts[1].key]);
    assert.deepEqual(state.failures, [{ accountId: "JUP_ACC_1", failure, resetAt }]);
    assert.deepEqual(state.releases, ["JUP_ACC_1", "JUP_ACC_2"]);
    assert.equal(state.successes, 1);
    assert.equal(events[0].status, status);
    assert.ok(!JSON.stringify(events).includes("test-key"));
  });
}

test("network and per-request timeout failures fall back", async () => {
  for (const error of [new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError")]) {
    const { scheduler, state } = fixture(); let requests = 0;
    const client = new JupiterClient(scheduler, { fetchPrices: async () => { if (++requests === 1) throw error; return result; } });
    assert.equal(await client.getPrices([SOL_MINT]), result);
    assert.equal(state.failures[0].failure, "transient");
  }
});

test("malformed responses and non-retryable HTTP errors do not rotate or penalize credentials", async () => {
  for (const error of [new JupiterDataError("malformed"), new JupiterHttpError(400, null)]) {
    const { scheduler, state } = fixture(); let requests = 0;
    const client = new JupiterClient(scheduler, { fetchPrices: async () => { requests++; throw error; } });
    await assert.rejects(client.getPrices([SOL_MINT]), isCode(error instanceof JupiterDataError ? "invalid_response" : "upstream_unavailable"));
    assert.equal(requests, 1); assert.equal(state.failures.length, 0); assert.equal(state.releases.length, 1);
  }
});

test("missing token rows are returned for ingestion validation without exhausting accounts", async () => {
  const { scheduler, state } = fixture(); const missing = new Map();
  assert.equal(await new JupiterClient(scheduler, { fetchPrices: async () => missing }).getPrices([SOL_MINT]), missing);
  assert.equal(state.acquisitions, 1); assert.equal(state.failures.length, 0);
});

test("fallback is bounded to three distinct accounts even with ten available", async () => {
  const { scheduler, state } = fixture(); const keys = [];
  const client = new JupiterClient(scheduler, { fetchPrices: async key => { keys.push(key); throw new JupiterHttpError(503, null); } });
  await assert.rejects(client.getPrices([SOL_MINT]), isCode("upstream_unavailable"));
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 3); assert.equal(state.releases.length, 3);
});

test("all accounts cooling down return their wait without an HTTP request", async () => {
  const { scheduler } = fixture({ next: async () => ({ waitMs: 12_345 }) }); let requests = 0;
  const client = new JupiterClient(scheduler, { fetchPrices: async () => { requests++; return result; } });
  await assert.rejects(client.getPrices([SOL_MINT]), error => isCode("quota_wait")(error) && error.retryAfterMs === 12_345);
  assert.equal(requests, 0);
});

test("Redis failures fail closed before HTTP and stop fallback after an HTTP failure", async () => {
  for (const broken of ["next", "failed", "release"]) {
    const { scheduler } = fixture({ [broken]: async () => { throw new Error("Redis unavailable"); } }); let requests = 0;
    const client = new JupiterClient(scheduler, { fetchPrices: async () => { requests++; throw new JupiterHttpError(429, null); } });
    await assert.rejects(client.getPrices([SOL_MINT]), isCode("scheduler_unavailable"));
    assert.equal(requests, broken === "next" ? 0 : 1);
  }
});

test("logical deadline aborts fetch, releases its lease and performs no fallback", async () => {
  const { scheduler, state } = fixture();
  const client = new JupiterClient(scheduler, { deadlineMs: 30, fetchPrices: async (_key, _mints, { signal }) => {
    await delay(1_000, undefined, { signal }); return result;
  } });
  await assert.rejects(client.getPrices([SOL_MINT]), isCode("deadline"));
  assert.equal(state.acquisitions, 1); assert.equal(state.releases.length, 1); assert.equal(state.failures.length, 0);
});

test("limits concurrency, removes cancelled queued calls and remains usable", async () => {
  const { scheduler } = fixture(); let active = 0; let maximum = 0; let requests = 0;
  const client = new JupiterClient(scheduler, { maxConcurrent: 1, fetchPrices: async () => {
    active++; maximum = Math.max(maximum, active); requests++; await delay(25); active--; return result;
  } });
  const first = client.getPrices([SOL_MINT]); const abort = new AbortController();
  const cancelled = client.getPrices([SOL_MINT], abort.signal);
  const rejection = assert.rejects(cancelled, isCode("cancelled")); abort.abort();
  await Promise.all([first, rejection, client.getPrices([SOL_MINT]), client.getPrices([SOL_MINT])]);
  assert.equal(maximum, 1); assert.equal(requests, 3);
  assert.equal(await client.getPrices([SOL_MINT]), result);
});

test("invalid batch consumes no quota", async () => {
  const { scheduler, state } = fixture(); const client = new JupiterClient(scheduler);
  await assert.rejects(client.getPrices([]), JupiterDataError);
  await assert.rejects(client.getPrices(Array(51).fill(SOL_MINT)), JupiterDataError);
  assert.equal(state.acquisitions, 0);
});

test("Tokens 403 rotates with product permission failure and uses the same bounded transport", async () => {
  const { scheduler,state } = fixture(); let calls=0;
  const client = new JupiterClient(scheduler,{fetchTokens:async()=>{if(++calls===1)throw new JupiterHttpError(403,null);return [];}});
  assert.deepEqual(await client.getTokens("SOL"),[]); assert.equal(state.failures[0].failure,"permission"); assert.equal(state.releases.length,2);
});
