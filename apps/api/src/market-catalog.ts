import { registeredInstruments } from "@socially/market-data/registry";
import { createHash, randomUUID } from "node:crypto";
import type { DbPool } from "@socially/db";
import { currentPrice, marketRedis, type MarketEvent } from "@socially/market-stream";
import { supportedTokens, supportedByMint } from "@socially/market-data/catalog";
import { JupiterClient } from "@socially/market-data/client";
import { JupiterScheduler } from "@socially/market-data/scheduler";
import { loadJupiterAccounts } from "@socially/market-data/config";
import type { TokenMetadata } from "@socially/market-data/tokens";
import { ApiFault } from "./errors.js";

export { historyRanges, type HistoryRange } from '@socially/market-data/history';
import { readHistory as history, type HistoryRange } from '@socially/market-data/history';
export async function readHistory(pool: DbPool, mint: string, range: HistoryRange, now = new Date()) {
  if (!(await registeredInstruments(pool,undefined,[mint])).length) throw new ApiFault(422, 'history_unsupported', 'History is collected for supported markets only');
  return history(pool, mint, range, now);
}

/** Cache and coalesce provider searches across gateways; ingestion keeps its own reserved budget. */
export class MarketCatalog {
  private redis?: ReturnType<typeof marketRedis>;
  private client?: JupiterClient;
  private readonly pending = new Map<string, Promise<TokenMetadata[]>>();
  constructor(private readonly pool: DbPool) {}
  close() { this.redis?.disconnect(); }
  private provider() {
    if (!this.client) {
      if (!process.env.REDIS_URL) throw new ApiFault(503, "search_unavailable", "Market search is temporarily unavailable");
      this.redis ??= marketRedis(process.env.REDIS_URL);
      this.client = new JupiterClient(new JupiterScheduler(this.redis, loadJupiterAccounts(), "tokens-v2"));
    }
    return this.client;
  }
  async search(query: string): Promise<TokenMetadata[]> {
    // Solana addresses are case-sensitive; cache identity must preserve the query.
    const key = createHash("sha256").update(query).digest("hex");
    // Admission bounds upstream misses, not readers of already shared search results.
    if(process.env.REDIS_URL){
      const redis=this.redis??=marketRedis(process.env.REDIS_URL);
      for(let i=0;redis.status!=='ready'&&i<20;i++)await new Promise(resolve=>setTimeout(resolve,25));
      try{const cached=await redis.get(`socially:market:search:${key}`);if(cached)return JSON.parse(cached) as TokenMetadata[];}
      catch{throw new ApiFault(503,'search_unavailable','Market search is temporarily unavailable');}
    }
    const prior = this.pending.get(key); if (prior) return prior;
    if (this.pending.size >= 16) throw new ApiFault(503, "search_busy", "Please retry your search shortly");
    const promise = this.searchShared(query, key).finally(() => this.pending.delete(key));
    this.pending.set(key, promise); return promise;
  }
  private async searchShared(query: string, key: string): Promise<TokenMetadata[]> {
    try {
      if (!process.env.REDIS_URL) throw new ApiFault(503, "search_unavailable", "Market search is temporarily unavailable");
      const redis = this.redis ??= marketRedis(process.env.REDIS_URL);
      for (let i=0;redis.status!=='ready' && i<20;i++) await new Promise(resolve=>setTimeout(resolve,25));
      if (redis.status!=='ready') throw new ApiFault(503,'search_unavailable','Market search is temporarily unavailable');
      const cached = await redis.get(`socially:market:search:${key}`);
      if (cached) return JSON.parse(cached) as TokenMetadata[];
      const owner = randomUUID(), lock = `socially:market:search-lock:${key}`;
      if (!await redis.set(lock, owner, "PX", 10_000, "NX")) throw new ApiFault(503, "search_busy", "Search is updating; retry shortly");
      try {
        // Shared 120/minute cap protects the 12/minute ingestion path from search bursts.
        const count = Number(await redis.eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],60000) end; return n`, 1, "socially:market:search-budget"));
        if (count > 120) throw new ApiFault(429, "search_rate_limited", "Too many market searches; retry shortly");
        const result = await this.provider().getTokens(query);
        for (const token of result) await this.pool.query(`INSERT INTO market_token_metadata(mint,payload,fetched_at) VALUES($1,$2,now())
          ON CONFLICT(mint) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=EXCLUDED.fetched_at`, [token.mint, token]);
        await redis.set(`socially:market:search:${key}`, JSON.stringify(result), "EX", 60);
        return result;
      } finally {
        await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lock, owner);
      }
    } catch (error) {
      if (error instanceof ApiFault) throw error;
      throw new ApiFault(503, "search_unavailable", "Market search is temporarily unavailable");
    }
  }
  async list(query: string, savedMints?: string[]) {
    const registry = query ? [] : await registeredInstruments(this.pool,undefined,savedMints ?? supportedTokens.map(t=>t.mint));
    const byMint = new Map(registry.map(t=>[t.mint,t]));
    const matches = query ? await this.search(query) : [];
    const mints = savedMints ?? (query ? matches.map(token => token.mint) : supportedTokens.map(token => token.mint));
    const resolved = query ? await registeredInstruments(this.pool,undefined,mints) : registry;
    for(const token of resolved) byMint.set(token.mint,token);
    const rows = (await this.pool.query<{ payload: TokenMetadata; fetched_at: Date }>("SELECT payload,fetched_at FROM market_token_metadata WHERE mint=ANY($1::text[])", [mints])).rows;
    const metadata = new Map(rows.map(row => [row.payload.mint, row]));
    const prices = (await this.pool.query<{ payload: MarketEvent }>("SELECT payload FROM market_latest WHERE instrument_id=ANY($1::text[])", [resolved.map(t=>t.id)])).rows;
    const active = new Map(resolved.map(row => [row.id, row.active]));
    const marks = new Map(prices.map(row => [row.payload.price.mint, currentPrice(row.payload.price)]));
    const universe = savedMints ? savedMints.flatMap<Pick<TokenMetadata,'mint'|'symbol'|'name'|'decimals'|'icon'|'verified'|'suspicious'> & {supported: typeof registry[number] | undefined}>(mint => {
      const stored=metadata.get(mint)?.payload, registered=byMint.get(mint);
      // Held assets must remain visible even when optional provider metadata is missing.
      return stored ? [{...stored,supported:registered}] : registered ? [{...registered,icon:null,verified:null,suspicious:null,supported:registered}] : [];
    })
      : query ? matches.map(token => ({ ...token, supported: byMint.get(token.mint) }))
      : supportedTokens.map(token => ({ ...metadata.get(token.mint)?.payload, ...token, supported: byMint.get(token.mint) }));
    return universe.map(token => {
      const supported = token.supported, stored = metadata.get(token.mint);
      const metadataFresh = !!stored && Date.now() - stored.fetched_at.getTime() <= 300_000 &&
        !!stored.payload.providerUpdatedAt && Date.now() - Date.parse(stored.payload.providerUpdatedAt) <= 300_000 &&
        Date.parse(stored.payload.providerUpdatedAt) <= Date.now() + 5_000;
      const metrics = metadataFresh ? stored!.payload : null;
      const price = marks.get(token.mint) ?? null;
      return { mint: token.mint, instrumentId: supported?.id ?? null, symbol: supported?.symbol ?? token.symbol,
        name: supported?.name ?? token.name, decimals: supported?.decimals ?? token.decimals, icon: token.icon ?? null,
        category: supported?.category ?? "Unknown", tracked: !!supported,
        tradable: !!supported?.tradable && active.get(supported.id) === true,
        tradeReason: supported?.id === "USDC" ? "quote_asset" : supported ? supported.tradable && active.get(supported.id) ? null : "asset_disabled" : "unsupported_instrument",
        verified: token.verified ?? null, suspicious: token.suspicious ?? null, price,
        metrics: { denomination: "USD", source: "JUPITER_TOKENS_V2", at: stored?.payload.providerUpdatedAt ?? null,
          status: metadataFresh ? "CURRENT" : "UNAVAILABLE", liquidity: metrics?.liquidityUsd ?? null,
          volume24h: metrics?.volume24hUsd ?? null, change1h: metrics?.change1h ?? null,
          change24h: price?.status === "CURRENT" ? price.change24h ?? metrics?.change24h ?? null : metrics?.change24h ?? null } };
    });
  }
}
