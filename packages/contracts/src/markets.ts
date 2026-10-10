export type MarketInterval = '5m' | '1h' | '6h' | '24h' | '7d' | '30d';
export type MarketFeed = 'supported' | 'toptraded' | 'trending';
export type MarketSort = 'rank' | 'volume' | 'gainers' | 'losers' | 'relevance';
export type MarketStatus = 'CURRENT' | 'STALE' | 'UNAVAILABLE';
export type MarketToken = {
  mint: string; instrumentId: string | null; symbol: string; name: string; decimals: number; icon: string | null;
  category: 'major' | 'token' | 'memecoin' | 'unknown'; tracked: boolean; tradable: boolean; tradeReason: string | null;
  verified: boolean | null; suspicious: boolean | null; rank: number | null;
  price: { usd: string | null; source: 'JUPITER_PRICE_V3' | 'JUPITER_TOKENS_V2'; sourceAt: string | null;
    receivedAt: string; status: MarketStatus; usableForExecution: boolean } | null;
  metrics: { interval: string; volumeUsd: string | null; liquidityUsd: string | null; changePercent: string | null;
    source: 'JUPITER_TOKENS_V2' | 'RECORDED_SAMPLES'; asOf: string | null; status: MarketStatus;
    coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' };
};
export type MarketList = {
  schemaVersion: 1; mode: 'PAPER'; feed: MarketFeed | 'search'; interval: MarketInterval | null; sort: MarketSort;
  scope: 'SUPPORTED' | 'PROVIDER_CANDIDATES' | 'SEARCH_RESULTS'; snapshotId: string; asOf: string; fetchedAt: string;
  refreshAfter: string; status: 'CURRENT' | 'STALE'; rankingStatus: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE';
  candidateCount: number; unrankedCount: number; nextCursor: string | null; items: MarketToken[];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const dec = (v: unknown) => str(v) && /^-?\d{1,24}(\.\d{1,18})?$/.test(v);
const date = (v: unknown) => str(v) && Number.isFinite(Date.parse(v));
const nil = (v: unknown, check: (v: unknown) => boolean) => v === null || check(v);
const member = (v: unknown, values: string[]) => str(v) && values.includes(v);
const status = (v: unknown) => member(v, ['CURRENT', 'STALE', 'UNAVAILABLE']);
const bool = (v: unknown) => typeof v === 'boolean';
const natural = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function parseMarketList(v: unknown): MarketList {
  function fail(): never { throw new Error('Invalid market discovery response'); }
  if (!object(v) || v.schemaVersion !== 1 || v.mode !== 'PAPER' || !member(v.feed, ['supported','toptraded','trending','search']) ||
    !nil(v.interval, x => member(x,['5m','1h','6h','24h','7d','30d'])) || !member(v.sort,['rank','volume','gainers','losers','relevance']) ||
    !member(v.scope,['SUPPORTED','PROVIDER_CANDIDATES','SEARCH_RESULTS']) || !str(v.snapshotId) || !date(v.asOf) || !date(v.fetchedAt) ||
    !date(v.refreshAfter) || !member(v.status,['CURRENT','STALE']) || !member(v.rankingStatus,['AVAILABLE','PARTIAL','UNAVAILABLE']) ||
    !natural(v.candidateCount) || !natural(v.unrankedCount) || !nil(v.nextCursor,str) || !Array.isArray(v.items) || v.items.length > 50) fail();
  const seen = new Set<string>();
  for (const t of v.items as unknown[]) {
    if (!object(t) || !str(t.mint) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.mint) || seen.has(t.mint) ||
      !nil(t.instrumentId,str) || !str(t.symbol) || !str(t.name) || !natural(t.decimals) || Number(t.decimals)>18 || !nil(t.icon,str) ||
      !member(t.category,['major','token','memecoin','unknown']) || !bool(t.tracked) || !bool(t.tradable) || !nil(t.tradeReason,str) ||
      !nil(t.verified,bool) || !nil(t.suspicious,bool) || !nil(t.rank,x => natural(x) && Number(x)>0) || !object(t.metrics)) fail();
    if (t.tradable && (!t.tracked || !t.instrumentId)) fail();
    seen.add(t.mint as string);
    const m = t.metrics as Record<string, unknown>;
    if (!str(m.interval) || ![m.volumeUsd,m.liquidityUsd,m.changePercent].every(x => nil(x,dec)) || [m.volumeUsd,m.liquidityUsd].some(x => x !== null && Number(x)<0) ||
      !member(m.source,['JUPITER_TOKENS_V2','RECORDED_SAMPLES']) || !nil(m.asOf,date) || !status(m.status) || !member(m.coverage,['COMPLETE','PARTIAL','UNAVAILABLE'])) fail();
    if (t.price !== null) {
      const p = t.price;
      if (!object(p) || !nil(p.usd,x => dec(x) && Number(x)>0) || !member(p.source,['JUPITER_PRICE_V3','JUPITER_TOKENS_V2']) ||
        !nil(p.sourceAt,date) || !date(p.receivedAt) || !status(p.status) || !bool(p.usableForExecution) ||
        p.usableForExecution && (!t.tracked || p.source !== 'JUPITER_PRICE_V3' || p.status !== 'CURRENT') ||
        p.status === 'CURRENT' && (!p.usd || !p.sourceAt)) fail();
    }
  }
  return v as MarketList;
}

export type MarketTracking = { mode:'PAPER'; instrumentId:string; mint:string; state:'READY'|'WARMING'|'STALE'|'UNAVAILABLE'; reason:string|null; retryAfterMs:number; leaseExpiresAt:string };
export function parseMarketTracking(v:unknown):MarketTracking {
  if(!object(v)||v.mode!=='PAPER'||!str(v.instrumentId)||v.instrumentId.length>64||!str(v.mint)||! /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.mint)||
    !member(v.state,['READY','WARMING','STALE','UNAVAILABLE'])||!nil(v.reason,str)||!natural(v.retryAfterMs)||!date(v.leaseExpiresAt))throw new Error('Invalid market tracking response');
  return v as MarketTracking;
}
