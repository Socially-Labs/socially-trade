import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestJupiter, recordMarketPrice, unavailable } from "../dist/ingest.js";
import { supportedTokens } from "@socially/market-data/catalog";
import { fetchJupiterPrices, JupiterDataError, JupiterHttpError, SOL_MINT, USDC_MINT } from "@socially/market-data";

function poolFixture(prior) {
  const writes = []; const queries = []; let payload = prior ? { price: prior } : undefined;
  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      if (sql.startsWith("SELECT payload")) return { rows: payload ? [{ payload }] : [] };
      if (sql.startsWith("SELECT source_at")) return { rows: prior?.sourceAt ? [{ source_at: new Date(prior.sourceAt) }] : [] };
      if (sql.startsWith("UPDATE market_feed_state")) return { rows: [{ sequence: "2" }] };
      if (sql.startsWith("INSERT INTO market_events")) { payload = params[2]; writes.push(payload); }
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, writes, queries };
}

test("unavailable event preserves the last price and source/receipt timestamps, and repeated failures deduplicate", async () => {
  const prior = { ...unavailable(""), priceUsd: "150", priceUsdc: "150.1", sourceAt: "2026-10-01T00:00:00.000Z",
    receivedAt: "2026-10-01T00:00:01.000Z", sourceBlockId: "123", quoteSourceBlockId: "122",
    quoteSourceAt: "2026-10-01T00:00:00.000Z", observationId: "original-observation", status: "CURRENT", reason: null };
  const { pool, writes, queries } = poolFixture(prior);
  await recordMarketPrice(pool, unavailable("upstream_unavailable"));
  await recordMarketPrice(pool, unavailable("upstream_unavailable"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, "market_status");
  assert.deepEqual(writes[0].price, { ...prior, status: "UNAVAILABLE", reason: "upstream_unavailable" });
  assert.ok(!queries.some(sql => sql.startsWith("INSERT INTO price_observations")));
});

test("first failure without a previous price still publishes a null unavailable mark", async () => {
  const { pool, writes } = poolFixture(); await recordMarketPrice(pool, unavailable("upstream_unavailable"));
  assert.equal(writes[0].price.priceUsdc, null); assert.equal(writes[0].price.sourceAt, null);
});

test("missing token rows produce a data-quality status without source-time RPC calls", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("RPC should not be called"); });
  const { pool, writes } = poolFixture(); let requests = 0;
  await ingestJupiter(pool, { getPrices: async mints => { requests++; assert.deepEqual(mints, supportedTokens.map(token => token.mint)); return new Map(); } }, "https://rpc.invalid");
  assert.equal(requests, 1); assert.equal(writes[0].price.reason, "price_missing_or_invalid");
});

test("Jupiter adapter uses only the key header and parses absolute reset seconds", async t => {
  const reset = Math.floor(Date.now() / 1_000) + 60;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://api.jup.ag"); assert.equal(url.pathname, "/price/v3");
    assert.equal(url.searchParams.get("ids"), `${SOL_MINT},${USDC_MINT}`);
    assert.ok(!String(url).includes("fixture-key")); assert.equal(options.headers["x-api-key"], "fixture-key");
    return new Response(null, { status: 429, headers: { "x-ratelimit-reset": String(reset) } });
  });
  await assert.rejects(fetchJupiterPrices("fixture-key", [SOL_MINT, USDC_MINT]), error =>
    error instanceof JupiterHttpError && error.status === 429 && error.resetAt === reset * 1_000);
});

test("adapter rejects malformed JSON and top-level data, and omits invalid mint rows", async t => {
  const mocked = t.mock.method(globalThis, "fetch", async () => new Response("invalid json"));
  await assert.rejects(fetchJupiterPrices("fixture", [SOL_MINT]), JupiterDataError);
  mocked.mock.mockImplementation(async () => Response.json([]));
  await assert.rejects(fetchJupiterPrices("fixture", [SOL_MINT]), JupiterDataError);
  mocked.mock.mockImplementation(async () => Response.json({
    [SOL_MINT]: { usdPrice: 150.25, blockId: 123, decimals: 9 },
    [USDC_MINT]: { usdPrice: -1, blockId: 123, decimals: 6 },
  }));
  const prices = await fetchJupiterPrices("fixture", [SOL_MINT, USDC_MINT]);
  assert.equal(prices.get(SOL_MINT).priceUsd, "150.250000000000000000"); assert.equal(prices.has(USDC_MINT), false);
});
