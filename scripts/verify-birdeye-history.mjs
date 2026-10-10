// Prints coverage only. Never print the API key or request headers.
import { BirdeyeHistoryProvider } from '../packages/market-data/dist/backfill.js';
if (process.argv.includes('--api')) {
  const url='http://127.0.0.1:3000/v0/market/tokens/So11111111111111111111111111111111111111112/history?range=24H&backfill=true';
  for (let i=0;i<35;i++) {
    const response=await fetch(url,{signal:AbortSignal.timeout(5000),headers:{connection:"close"}}); const h=await response.json();
    if(!response.ok)throw new Error(JSON.stringify(h));
    if(h.source==='BIRDEYE_TOKEN_USD'&&h.points.length>250){console.log(JSON.stringify({source:h.source,range:h.range,points:h.points.length,coverage:h.coverage,backfillStatus:h.backfillStatus}));process.exit(0);}
    if(i%5===0)console.log(JSON.stringify({source:h.source,points:h.points?.length,backfillStatus:h.backfillStatus}));
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('History pipeline did not return Birdeye candles within 35 seconds');
}
if (!process.env.BIRDEYE_API_KEY) throw new Error('BIRDEYE_API_KEY missing');
const end = new Date(Math.floor(Date.now() / 300000) * 300000);
const start = new Date(end.getTime() - 86400000);
const candles = await new BirdeyeHistoryProvider(process.env.BIRDEYE_API_KEY).fetch(
  process.argv[2] ?? 'So11111111111111111111111111111111111111112', start, end, 300);
console.log(JSON.stringify({ source: 'BIRDEYE_TOKEN_USD', range: '24H', candles: candles.length,
  first: candles[0]?.at, last: candles.at(-1)?.at }));
