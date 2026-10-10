import {createPool} from '../packages/db/dist/index.js';
import {marketRedis} from '../packages/market-stream/dist/index.js';
import {writeFile} from 'node:fs/promises';
process.loadEnvFile('.env');const pool=createPool(),redis=marketRedis(process.env.REDIS_URL);
try{
 for(let i=0;i<40&&redis.status!=='ready';i++)await new Promise(r=>setTimeout(r,25));
 const prices=(await pool.query("SELECT i.id,ml.payload->'price' AS price,s.* FROM instruments i LEFT JOIN market_latest ml ON ml.instrument_id=i.id LEFT JOIN market_tracking_state s ON s.instrument_id=i.id ORDER BY i.id")).rows;
 const locks=(await pool.query('SELECT objid,pid FROM pg_locks WHERE locktype=\'advisory\'')).rows;
 const keys=await redis.keys('socially:{jupiter:*}:window');const windows=[];for(const key of keys)windows.push({key,count:await redis.zcard(key),latest:await redis.zrevrange(key,0,0,'WITHSCORES')});
 const services=[];for(const url of ['http://127.0.0.1:3000/health','http://127.0.0.1:8081/']){try{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});services.push({url,status:r.status});}catch(e){services.push({url,error:e.message});}}
 const plans={};if(process.argv.includes('--plans'))for(const [name,sql] of Object.entries({
  registry:"SELECT id FROM instruments WHERE mint_address='EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'",
  due:'SELECT instrument_id FROM market_tracking_state WHERE next_due_at<=now() ORDER BY priority,next_due_at LIMIT 49',
  holdings:"SELECT DISTINCT p.instrument_id FROM positions p JOIN funds f ON f.id=p.fund_id WHERE p.quantity>0 AND f.status<>'COMPLETED'",
  observation:"SELECT id FROM price_observations WHERE instrument_id='SOL' ORDER BY source_at DESC,received_at DESC LIMIT 1",
  chart:"SELECT bucket_at,close FROM market_chart_candles WHERE instrument_id='SOL' AND source='BIRDEYE_TOKEN_USD' AND series_id='solana:So11111111111111111111111111111111111111112:usd' AND resolution_seconds=300 AND bucket_at>now()-interval '24 hours' ORDER BY bucket_at LIMIT 720",
  pending:"SELECT id FROM orders WHERE status='PENDING' ORDER BY submitted_at LIMIT 100",
  privateContext:'SELECT instrument_id,quantity FROM positions WHERE fund_id=(SELECT id FROM funds LIMIT 1) AND quantity>0',
  outbox:'SELECT id FROM fund_events WHERE fund_id=(SELECT id FROM funds LIMIT 1) ORDER BY sequence DESC LIMIT 100'
 }))plans[name]=(await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`)).rows;
 const migrations=(await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r=>r.name);
 const report={at:new Date().toISOString(),migrations,capabilities:{dynamic:process.env.PAPER_DYNAMIC_MARKETS_ENABLED==='true',privateUpdates:process.env.PAPER_PRIVATE_UPDATES_ENABLED==='true',historyProvider:process.env.MARKET_HISTORY_PROVIDER_ENABLED==='true',historyCredentialPresent:!!process.env.BIRDEYE_API_KEY},prices,locks,windows,watched:await redis.zrange('socially:market:watched',0,-1,'WITHSCORES'),services,plans};
 if(process.argv.includes('--save'))await writeFile(new URL('../docs/dynamic-markets-runtime-evidence.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{redis.disconnect();await pool.end();}
