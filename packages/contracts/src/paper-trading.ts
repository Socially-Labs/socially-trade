export const executionStages=['WAITING_DELAY','WAITING_PRICE','WAITING_VALUATION','FILLED','REJECTED','CANCELLED'] as const;
export type ExecutionProgress={stage:typeof executionStages[number];eligibleAt:string;expiresAt:string;lastAttemptedAt:string|null;attempts:number;observationSourceAt:string|null;observationAgeMs:number|null;reason:string|null;retryAfterMs:number};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const natural=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const nullable=(v:unknown,check:(value:unknown)=>boolean)=>v===null||check(v);
const decimal=(v:unknown)=>typeof v==='string'&&/^-?\d{1,30}(\.\d{1,18})?$/.test(v);
export function parseExecutionProgress(v:unknown):ExecutionProgress{
 if(!record(v)||!executionStages.includes(v.stage as ExecutionProgress['stage'])||!date(v.eligibleAt)||!date(v.expiresAt)||
 !nullable(v.lastAttemptedAt,date)||!natural(v.attempts)||!nullable(v.observationSourceAt,date)||!nullable(v.observationAgeMs,natural)||
 !nullable(v.reason,x=>typeof x==='string')||!natural(v.retryAfterMs))throw new Error('Invalid execution progress');
 return v as ExecutionProgress;
}
export type TradingReturns={mode:'PAPER';range:'7D'|'30D'|'90D'|'ALL';method:'CHAINED_ECONOMIC_UNIT_PRICE';
 intervalSeconds:number;baselineAt:string|null;asOf:string|null;coverage:'PARTIAL'|'UNAVAILABLE';netReturnPercent:string|null;
 points:{at:string;indexValue:string|null;hasGap:boolean}[];methodology:string};
export function parseTradingReturns(v:unknown):TradingReturns{
 if(!record(v)||v.mode!=='PAPER'||!['7D','30D','90D','ALL'].includes(String(v.range))||v.method!=='CHAINED_ECONOMIC_UNIT_PRICE'||
 !natural(v.intervalSeconds)||v.intervalSeconds===0||!nullable(v.baselineAt,date)||!nullable(v.asOf,date)||
 !['PARTIAL','UNAVAILABLE'].includes(String(v.coverage))||!nullable(v.netReturnPercent,decimal)||!Array.isArray(v.points)||v.points.length>401||typeof v.methodology!=='string')throw new Error('Invalid trading returns');
 let previous=-Infinity;
 for(const p of v.points){if(!record(p)||!date(p.at)||!nullable(p.indexValue,x=>decimal(x)&&Number(x)>=0)||typeof p.hasGap!=='boolean'||Date.parse(String(p.at))<=previous)throw new Error('Invalid trading return point');previous=Date.parse(String(p.at));}
 return v as TradingReturns;
}
