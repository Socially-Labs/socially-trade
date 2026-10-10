import {randomUUID} from 'node:crypto';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createPool} from '../packages/db/dist/index.js';
import {marketRedis} from '../packages/market-stream/dist/index.js';
import {loadJupiterAccounts} from '../packages/market-data/dist/config.js';
import {JupiterScheduler} from '../packages/market-data/dist/scheduler.js';
import {JupiterClient} from '../packages/market-data/dist/client.js';
import {registeredInstruments} from '../packages/market-data/dist/registry.js';
import {registerInstrument,validateMintMetadata} from '../apps/api/dist/market-tracking.js';
import {recordMarketPrice,ingestJupiter} from '../apps/ingestor/dist/ingest.js';
import {createFund} from '../apps/api/dist/funds.js';
import {previewOrder,submitOrder} from '../apps/api/dist/orders.js';
import {processOrder} from '../apps/worker/dist/orders.js';
process.loadEnvFile('.env');
const pool=createPool(),redis=marketRedis(process.env.REDIS_URL),accounts=loadJupiterAccounts();
const mint=process.env.DYNAMIC_VERIFY_MINT??'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const rpc=process.env.MARKET_RPC_URL??'https://api.mainnet-beta.solana.com';
const calls={prices:0,tokens:0};
const tokens=new JupiterClient(new JupiterScheduler(redis,accounts,'tokens-v2'));
const prices=new JupiterClient(new JupiterScheduler(redis,accounts));
let isolated,schema;
const report={at:new Date().toISOString(),mint,credentialCount:accounts.length,organisations:new Set(accounts.map(a=>a.organisation)).size,liveUpstreamCalls:calls};
try {
  for(let i=0;i<40&&redis.status!=='ready';i++)await new Promise(r=>setTimeout(r,25));
  let metadata=(await pool.query("SELECT payload FROM market_token_metadata WHERE mint=$1 AND fetched_at>now()-interval '1 hour'",[mint])).rows[0]?.payload;if(!metadata){calls.tokens++;metadata=(await tokens.getTokens(mint)).find(t=>t.mint===mint);}if(!metadata)throw new Error('Provider has no metadata for selected mint');
  await validateMintMetadata(mint,metadata.decimals,rpc);
  await pool.query('INSERT INTO market_token_metadata(mint,payload) VALUES($1,$2) ON CONFLICT(mint) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=now()',[mint,metadata]);
  const token=await registerInstrument(pool,metadata);report.instrumentId=token.id;
  await redis.zadd('socially:market:watched',Date.now()+60000,token.id);
  report.migration=(await pool.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows[0].name;
  report.openPaperFunds=(await pool.query("SELECT f.id,f.round_model_version,r.phase,p.universe_mode FROM funds f LEFT JOIN vault_rounds r ON r.fund_id=f.id JOIN LATERAL(SELECT universe_mode FROM fund_policy_versions WHERE fund_id=f.id ORDER BY version DESC LIMIT 1)p ON true WHERE f.status IN ('ACTIVE','FROZEN') AND f.mode='PAPER'")).rows;
  // Live-provider execution in disposable SQL storage: no user's balances or auth records change.
  schema=`dynamic_live_${randomUUID().replaceAll('-','')}`;await pool.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);isolated=createPool(url.toString());
  const migrations=new URL('../packages/db/migrations/',import.meta.url);for(const file of(await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await isolated.query(await readFile(new URL(file,migrations),'utf8'));
  await isolated.query('INSERT INTO market_token_metadata(mint,payload) VALUES($1,$2)',[mint,metadata]);
  const selected=await registerInstrument(isolated,metadata),actor={id:randomUUID(),role:'captain'};
  await isolated.query("INSERT INTO users(id,auth_subject,display_name,paper_cash,username,role) VALUES($1,$2,'Live verification',10000,$3,'captain')",[actor.id,`did:privy:verification-${actor.id}`,`verify_${actor.id.slice(0,8)}`]);
  const fund=await createFund(isolated,actor,{name:'Live dynamic verification',description:'Disposable provider verification'},randomUUID());
  const refresh=async()=>{
    await redis.zadd('socially:market:watched',Date.now()+30000,token.id);
    const price=(await pool.query('SELECT payload FROM market_latest WHERE instrument_id=$1',[token.id])).rows[0]?.payload.price;
    if(price && price.priceUsdc && price.sourceAt && Date.now()-Date.parse(price.sourceAt)<=15000) {
      const quote=(await pool.query('SELECT quote_usd::text FROM price_observations WHERE id=$1',[price.observationId])).rows[0]?.quote_usd;
      if(quote)await recordMarketPrice(isolated,price,quote);
    }
  };
  for(let i=0;i<12;i++){await refresh();if((await isolated.query('SELECT 1 FROM price_observations LIMIT 1')).rowCount)break;await new Promise(r=>setTimeout(r,2000));}
  const buyIntent={side:'BUY',instrumentId:selected.id,notionalUsdc:'10'};
  report.preview=await previewOrder(isolated,actor,fund.id,buyIntent);
  const fill=async intent=>{
    const receipt=await submitOrder(isolated,actor,fund.id,intent,randomUUID());
    for(let attempt=0;attempt<12;attempt++){
      await new Promise(r=>setTimeout(r,4000));await refresh();await processOrder(isolated,receipt.orderId);
      const order=(await isolated.query('SELECT status,reject_reason FROM orders WHERE id=$1',[receipt.orderId])).rows[0];
      if(order.status==='FILLED')return receipt.orderId;if(order.status!=='PENDING')throw new Error(`Live verification rejected: ${order.reject_reason}`);
    }throw new Error('No qualifying post-submission live observation within verification window');
  };
  const buyId=await fill(buyIntent);report.afterBuy=(await isolated.query('SELECT cash_usdc::text FROM funds WHERE id=$1',[fund.id])).rows[0];
  const held=(await isolated.query('SELECT quantity::text FROM positions WHERE fund_id=$1 AND instrument_id=$2',[fund.id,selected.id])).rows[0].quantity;report.afterBuy.quantity=held;
  const sellId=await fill({side:'SELL',instrumentId:selected.id,quantity:held});
  report.afterSell=(await isolated.query('SELECT cash_usdc::text FROM funds WHERE id=$1',[fund.id])).rows[0];
  report.afterSell.quantity=(await isolated.query('SELECT quantity::text FROM positions WHERE fund_id=$1 AND instrument_id=$2',[fund.id,selected.id])).rows[0].quantity;
  report.fills=(await isolated.query('SELECT o.side,f.quantity::text,f.fee_usdc::text,f.model_version,p.source,p.source_at,p.received_at FROM fills f JOIN orders o ON o.id=f.order_id JOIN price_observations p ON p.id=f.observation_id WHERE o.id=ANY($1::uuid[])',[[buyId,sellId]])).rows;
  report.unbalancedLedgerEvents=(await isolated.query('SELECT event_id,a.asset_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY event_id,a.asset_id HAVING sum(amount)<>0')).rowCount;
  report.result='VERIFIED';
} catch(error){report.result='GATED';report.reason=error.code??error.message;report.detail=error.message;process.exitCode=1;}
finally {
  if(isolated)await isolated.end();if(schema)await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await writeFile(new URL('../docs/dynamic-markets-live-evidence.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));redis.disconnect();await pool.end();
}
