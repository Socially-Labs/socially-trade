import { registeredInstruments, dynamicTradingEnabled } from "@socially/market-data/registry";
import { createHash, randomUUID } from 'node:crypto';
import type { DbPool } from '@socially/db';
import type { MarketList, MarketToken, MarketInterval, MarketFeed, MarketSort } from '@socially/contracts';
import { Amount } from '@socially/domain';
import { marketRedis } from '@socially/market-stream';
import { supportedTokens, supportedByMint, mintPattern } from '@socially/market-data/catalog';
import { JupiterClient } from '@socially/market-data/client';
import { JupiterScheduler } from '@socially/market-data/scheduler';
import { loadJupiterAccounts } from '@socially/market-data/config';
import { DiscoveryCache, DiscoveryUnavailable } from '@socially/market-data/discovery';
import type { TokenMetadata } from '@socially/market-data/tokens';
import { MarketCatalog } from './market-catalog.js';
import { ApiFault } from './errors.js';

export type MarketQuery = { feed: MarketFeed | 'search'; sort: MarketSort; interval: MarketInterval; limit: number;
  category?: string; minLiquidityUsd?: string; tradableOnly: boolean; query?: string; cursor?: string };
const invalid = (): never => { throw new ApiFault(400, 'invalid_market_query', 'Invalid market filters, interval or cursor'); };
export function parseMarketQuery(raw: Record<string, unknown>, search = false): MarketQuery {
  if (Object.keys(raw).some(key => !['feed','sort','interval','limit','category','minLiquidityUsd','tradableOnly','query','cursor'].includes(key)) ||
    Object.values(raw).some(value => typeof value !== 'string')) invalid();
  const feed = search ? 'search' : raw.feed ?? 'supported', interval = raw.interval ?? '24h';
  const sort = search ? 'relevance' : raw.sort ?? (feed === 'supported' ? 'volume' : 'rank');
  const limit = raw.limit === undefined ? 20 : Number(raw.limit);
  if (!['supported','toptraded','trending','search'].includes(String(feed)) || !search && feed === 'search' ||
    !['5m','1h','6h','24h','7d','30d'].includes(String(interval)) ||
    (feed === 'supported' ? !['volume','gainers','losers'].includes(String(sort)) : ![search ? 'relevance' : 'rank'].includes(String(sort))) ||
    ['7d','30d'].includes(String(interval)) && (feed !== 'supported' || sort === 'volume') ||
    !Number.isInteger(limit) || limit<1 || limit>50 || raw.limit !== undefined && !/^\d+$/.test(String(raw.limit)) ||
    raw.category !== undefined && !['major','token','memecoin','unknown'].includes(String(raw.category)) ||
    raw.minLiquidityUsd !== undefined && (!/^\d{1,13}(\.\d{1,18})?$/.test(String(raw.minLiquidityUsd)) || Number(raw.minLiquidityUsd)>1e12) ||
    raw.tradableOnly !== undefined && !['true','false'].includes(String(raw.tradableOnly)) ||
    raw.cursor !== undefined && (String(raw.cursor).length>1024) ||
    search && (typeof raw.query !== 'string' || !raw.query.trim() || raw.query.trim().length>100) ||
    !search && raw.query !== undefined) invalid();
  return { feed: feed as MarketQuery['feed'], interval: interval as MarketInterval, sort: sort as MarketSort, limit,
    category: raw.category as string | undefined, minLiquidityUsd: raw.minLiquidityUsd as string | undefined,
    tradableOnly: raw.tradableOnly === 'true', query: search ? String(raw.query).trim() : undefined, cursor: raw.cursor as string | undefined };
}
export function rankMarkets(items: MarketToken[], sort: MarketSort): MarketToken[] {
  if (sort === 'rank' || sort === 'relevance') return items;
  const metric = (t: MarketToken) => t.metrics.status === 'CURRENT' && t.metrics.coverage === 'COMPLETE'
    ? sort === 'volume' ? t.metrics.volumeUsd : t.metrics.changePercent : null;
  return [...items].sort((a,b) => {
    const x = metric(a), y = metric(b);
    if (x === null) return y === null ? a.mint.localeCompare(b.mint) : 1;
    if (y === null) return -1;
    return new Amount(x).cmp(y) * (sort === 'losers' ? 1 : -1) || a.mint.localeCompare(b.mint);
  }).map((t,i) => ({ ...t, rank: metric(t) === null ? null : i+1 }));
}
export class MarketDiscovery {
  private redis?: ReturnType<typeof marketRedis>;
  private cache?: DiscoveryCache;
  private catalog: MarketCatalog;
  private prepared = new Map<string, { at: number; value: Promise<MarketList> }>();
  constructor(private pool: DbPool) { this.catalog = new MarketCatalog(pool); }
  close() { this.cache?.close(); this.redis?.disconnect(); this.catalog.close(); }
  private connection() {
    if (!this.redis) {
      if (!process.env.REDIS_URL) throw new DiscoveryUnavailable();
      this.redis = marketRedis(process.env.REDIS_URL);
    }
    return this.redis;
  }
  private async pages() {
    const redis = this.connection();
    for (let i=0; i<20 && ['connecting','connect'].includes(redis.status); i++) await new Promise(resolve=>setTimeout(resolve,25));
    return redis;
  }
  private provider() {
    if (!this.cache) {
      const accounts = loadJupiterAccounts(), redis = this.connection();
      this.cache = new DiscoveryCache(this.pool, redis, new JupiterClient(new JupiterScheduler(redis,accounts,'tokens-v2')));
    }
    return this.cache;
  }
  async list(q: MarketQuery): Promise<MarketList> {
    const { cursor, ...filters } = q;
    const key = createHash('sha256').update(JSON.stringify(filters)).digest('hex');
    let full: MarketList, offset = 0;
    if (cursor) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch { invalid(); }
      if (!decoded || decoded.key !== key || typeof decoded.id !== 'string' || !Number.isSafeInteger(decoded.offset) || decoded.offset<1) invalid();
      offset = decoded.offset;
      let cached: string | null = null;
      try { cached = await (await this.pages()).get(`socially:discovery:page:${decoded.id}:${key}`); } catch { /* Expired/disposable snapshot. */ }
      if (!cached) throw new ApiFault(409,'feed_snapshot_expired','Market snapshot expired; restart from page one');
      full = JSON.parse(cached) as MarketList;
      if (offset>=full.items.length || offset%q.limit!==0) invalid();
      if (Date.now()-Date.parse(full.asOf)>600_000) throw new ApiFault(409,'feed_snapshot_expired','Market snapshot expired; restart from page one');
      if (Date.now()-Date.parse(full.fetchedAt)>300_000 && full.feed!=='supported') throw new ApiFault(409,'feed_snapshot_expired','Market snapshot is too old; restart from page one');
    } else {
      const prior = this.prepared.get(key);
      if (prior && Date.now()-prior.at<15_000) full = await prior.value;
      else {
        if (this.prepared.size>=64) this.prepared.delete(this.prepared.keys().next().value!);
        const value = this.build(q); this.prepared.set(key,{at:Date.now(),value});
        try { full = await value; } catch (error) { this.prepared.delete(key); throw error; }
      }
    }
    if (full.feed !== 'supported' && Date.now()-Date.parse(full.fetchedAt)>300_000) { this.prepared.delete(key); throw new ApiFault(503,'market_feed_unavailable','Market feed is temporarily unavailable'); }
    const observedNow = Date.now();
    const items = full.items.slice(offset, offset+q.limit).map(token => {
      const p = token.price;
      const maxPriceAge = p?.source === 'JUPITER_PRICE_V3' ? 15_000 : 300_000;
      const maxReceiptAge = p?.source === 'JUPITER_PRICE_V3' ? 15_000 : 60_000;
      const expired = p && (!p.sourceAt || observedNow-Date.parse(p.sourceAt)>maxPriceAge ||
        Date.parse(p.sourceAt)>observedNow+5000 || observedNow-Date.parse(p.receivedAt)>maxReceiptAge);
      const historical = token.metrics.source === 'RECORDED_SAMPLES';
      const metricsExpired = !token.metrics.asOf || observedNow-Date.parse(token.metrics.asOf)>(historical ? 120_000 : 300_000) ||
        !historical && observedNow-Date.parse(full.fetchedAt)>60_000;
      return { ...token,
        price: p && expired && p.status !== 'UNAVAILABLE' ? { ...p, status: 'STALE' as const, usableForExecution: false } : p,
        metrics: metricsExpired && token.metrics.status === 'CURRENT' ? { ...token.metrics, status: 'STALE' as const } : token.metrics };
    });
    const hasNext = offset+q.limit<full.items.length;
    if (hasNext) {
      try {
        const redis = await this.pages();
        await redis.set(`socially:discovery:page:${full.snapshotId}:${key}`, JSON.stringify(full), 'PX', Math.max(1, 600_000-(Date.now()-Date.parse(full.asOf))));
      } catch { throw new ApiFault(503,'market_feed_unavailable','Market pagination is temporarily unavailable'); }
    }
    return { ...full, status: full.status === 'STALE' || Date.now()>Date.parse(full.refreshAfter) ? 'STALE' : 'CURRENT',
      items, nextCursor: hasNext ? Buffer.from(JSON.stringify({ id:full.snapshotId,key,offset:offset+q.limit })).toString('base64url') : null };
  }
  private async build(q: MarketQuery): Promise<MarketList> {
    let now = Date.now(), asOf = new Date(now).toISOString();
    const metadataFetched = new Map<string,string>();
    let tokens: TokenMetadata[], fetchedAt: string;
    if (q.feed==='supported') {
      const rows = (await this.pool.query<{payload:TokenMetadata; fetched_at:Date}>('SELECT payload,fetched_at FROM market_token_metadata WHERE mint=ANY($1::text[])',[supportedTokens.map(t=>t.mint)])).rows;
      for (const row of rows) metadataFetched.set(row.payload.mint,row.fetched_at.toISOString());
      const metadata = new Map(rows.map(r=>[r.payload.mint,r.payload]));
      tokens = supportedTokens.map(t=>metadata.get(t.mint) ?? { ...t, schemaVersion:2, usdPrice:null, stats:{}, icon:null, verified:null,suspicious:null,liquidityUsd:null,volume24hUsd:null,change1h:null,change24h:null,providerUpdatedAt:null });
      fetchedAt = rows.length ? new Date(Math.min(...rows.map(r=>r.fetched_at.getTime()))).toISOString() : asOf;
    } else {
      try {
        const cache = this.provider();
        if (q.feed !== 'search') await this.redis!.set(`socially:discovery:demand:${q.feed}:${q.interval}`, '1', 'EX', 900).catch(() => undefined);
        const snapshot = q.feed==='search' ? await cache.search(q.query!) : await cache.category(q.feed,q.interval);
        tokens = snapshot.tokens; fetchedAt = snapshot.fetchedAt;
      } catch (error) {
        if (error instanceof DiscoveryUnavailable) throw new ApiFault(error.limited ? 429 : 503, error.limited ? 'market_rate_limited' : 'market_feed_unavailable',error.message);
        throw new ApiFault(503,'market_feed_unavailable','Market feed is temporarily unavailable');
      }
    }
    const registry = await registeredInstruments(this.pool,undefined,tokens.map(t=>t.mint));
    const byMint = new Map(registry.map(t=>[t.mint,t]));
    const supported = new Map((await this.catalog.list('',tokens.map(t=>t.mint))).map(t=>[t.mint,t]));
    const historical = ['7d','30d'].includes(q.interval);
    const rollups = historical ? (await this.pool.query<{instrument_id:string;payload:{changePercent:string|null;coverage:{status:MarketToken['metrics']['coverage']};asOf:string};computed_at:Date}>('SELECT instrument_id,payload,computed_at FROM market_return_rollups WHERE interval=$1',[q.interval])).rows : [];
    const returns = new Map(rollups.map(r=>[r.instrument_id,r]));
    now = Date.now(); asOf = new Date(now).toISOString();
    const items: MarketToken[] = tokens.map((t,i) => {
      const known = byMint.get(t.mint), live = supported.get(t.mint), p = live?.price;
      const tokenFetchedAt = metadataFetched.get(t.mint) ?? fetchedAt;
      const metadataCurrent = now-Date.parse(tokenFetchedAt)<=60_000 && !!t.providerUpdatedAt && now-Date.parse(t.providerUpdatedAt)<=300_000 && Date.parse(t.providerUpdatedAt)<=now+5000;
      const metricStatus = metadataCurrent ? 'CURRENT' : now-Date.parse(tokenFetchedAt)<=300_000 ? 'STALE' : 'UNAVAILABLE';
      const window = t.stats?.[q.interval];
      const ret = known ? returns.get(known.id) : undefined, retFresh = !!ret && now-ret.computed_at.getTime()<=120_000;
      const change = historical ? retFresh ? ret!.payload.changePercent : null : window?.changePercent ?? null;
      const volume = historical ? null : window?.volumeUsd ?? null;
      const category = known?.category === 'Major assets' ? 'major' : known?.category === 'Tokens' ? 'token' : known?.category === 'Memecoins' ? 'memecoin' : 'unknown';
      const quote = !!p && p.priceUsd !== null;
      const metadataPrice = t.usdPrice && Number(t.usdPrice)>0 ? t.usdPrice : null;
      return { mint:t.mint, instrumentId:known?.id??null, symbol:known?.symbol??t.symbol, name:known?.name??t.name,
        decimals:known?.decimals??t.decimals, icon:t.icon,category,tracked:!!known,tradable:live?.tradable??false,
        tradeReason:live?.tradeReason??(dynamicTradingEnabled()?'registration_required':'unsupported_instrument'),verified:t.verified,suspicious:t.suspicious??null,rank:q.sort==='rank'||q.sort==='relevance'?i+1:null,
        price: quote ? {usd:p!.priceUsd,source:'JUPITER_PRICE_V3',sourceAt:p!.sourceAt,receivedAt:p!.receivedAt,status:p!.status,usableForExecution:p!.status==='CURRENT' && !!live?.tradable} : known ? null :
          {usd:metadataPrice,source:'JUPITER_TOKENS_V2',sourceAt:t.providerUpdatedAt,receivedAt:tokenFetchedAt,status:metadataPrice ? metricStatus : 'UNAVAILABLE',usableForExecution:false},
        metrics:{interval:q.interval,volumeUsd:volume,liquidityUsd:t.liquidityUsd,changePercent:change,
          source:historical?'RECORDED_SAMPLES':'JUPITER_TOKENS_V2',asOf:historical?ret?.payload.asOf??null:t.providerUpdatedAt,
          status:historical?retFresh?'CURRENT':'UNAVAILABLE':metricStatus,
          coverage:historical?retFresh?ret!.payload.coverage.status:'UNAVAILABLE':window && (change!==null || volume!==null)?'COMPLETE':'UNAVAILABLE'} };
    });
    const filtered = rankMarkets(items.filter(t=>(!q.category||t.category===q.category) && (!q.tradableOnly||t.tradable) &&
      (!q.minLiquidityUsd||t.metrics.liquidityUsd!==null && new Amount(t.metrics.liquidityUsd).gte(q.minLiquidityUsd))),q.sort);
    const unrankedCount = filtered.filter(t=>t.rank===null).length;
    return {schemaVersion:1,mode:'PAPER',feed:q.feed,interval:q.feed==='search'?null:q.interval,sort:q.sort,
      scope:q.feed==='supported'?'SUPPORTED':q.feed==='search'?'SEARCH_RESULTS':'PROVIDER_CANDIDATES',snapshotId:randomUUID(),asOf,fetchedAt,
      refreshAfter:new Date(Date.parse(fetchedAt)+60_000).toISOString(),status:now-Date.parse(fetchedAt)>60_000?'STALE':'CURRENT',
      rankingStatus:unrankedCount===filtered.length?'UNAVAILABLE':unrankedCount?'PARTIAL':'AVAILABLE',candidateCount:tokens.length,unrankedCount,nextCursor:null,items:filtered};
  }
  async detail(mint: string) {
    if (!mintPattern.test(mint)) invalid();
    const q = supportedByMint.has(mint) ? parseMarketQuery({limit:'50'}) : parseMarketQuery({query:mint},true);
    const list = await this.list(q);
    const token = list.items.find(t=>t.mint===mint);
    if (!token) throw new ApiFault(404,'token_not_found','Token not found');
    return {...list,items:[token]};
  }
}
