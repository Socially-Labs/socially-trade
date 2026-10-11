import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPool, inTransaction, ledgerAccountId, refreshCaptainDiscovery } from '../packages/db/dist/index.js';
import { Amount, fixed, VAULT_RULES } from '../packages/domain/dist/index.js';

const provenance=JSON.parse(await readFile(new URL('../seed/discovery/hyperliquid-reference.json',import.meta.url),'utf8'));
export const demoId=key=>{const h=createHash('sha256').update(`socially:discovery-demo:v1:${key}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
export const demoCaptains=[
 {key:'silver-tide',name:'Elias Silver',vault:'Silver Tide',capital:18000,crew:14,portrait:1},
 {key:'coral-compass',name:'Mara Flint',vault:'Coral Compass',capital:24500,crew:22,portrait:2},
 {key:'stormwake',name:'Isolde Drake',vault:'Stormwake',capital:9600,crew:9,portrait:3},
 {key:'golden-horizon',name:'Rowan Vale',vault:'Golden Horizon',capital:27500,crew:18,portrait:4},
 {key:'quiet-harbor',name:'Silas Crow',vault:'Quiet Harbor',capital:3200,crew:5,portrait:5},
].map((c,i)=>({...c,captainId:demoId(`captain:${c.key}`),fundId:demoId(`vault:${c.key}`),reference:provenance.references[i]}));

/** Original demo identities, exact balanced ledger entries, synthetic fixed-capital
 * NAV history. Uses the normal NAV trigger and discovery reader, never overrides
 * a real Captain's projections or pretends these are executed trading fills.
 */
export async function seedDiscoveryDemo(pool, now=new Date()) {
 const outcome=await inTransaction(pool,async client=>{
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query('SELECT pg_advisory_xact_lock(3691037)');
  const existing=(await client.query('SELECT captain_id,fund_id,media_key FROM discovery_demo_seeds')).rows;
  if(existing.length){
   if(existing.length!==5||!demoCaptains.every(c=>existing.some(r=>r.captain_id===c.captainId&&r.fund_id===c.fundId&&r.media_key===c.key)))throw new Error('Unexpected demo seed ownership; refusing to overwrite records.');
   return 'already present';
  }
  const start=new Date(now.getTime()-35*86400000);
  const crewIds=Array.from({length:22},(_,i)=>demoId(`crew:${i+1}`));
  for(const [i,id] of crewIds.entries())await client.query(`INSERT INTO users(id,auth_subject,display_name,username,role,bio)
   VALUES($1,$2,$3,$4,'crew','DEMO: fictional Crew member for development previews.')`,[id,`demo:discovery:v1:crew:${i+1}`,`Demo Crew ${i+1}`,`demo_crew_${i+1}`]);
  for(const [i,c] of demoCaptains.entries()){
   const isNew=i===4, fundingStart=isNew?now:start;
   const close=new Date(fundingStart.getTime()+72*3600000),end=new Date(close.getTime()+90*86400000);
   const terms={...VAULT_RULES,universeMode:'LEGACY_ALLOWLIST',fundingWindowHours:72,durationDays:90,fundingCancellation:'FULL_BEFORE_DEADLINE',captainCancellation:'BEFORE_FIRST_CREW_COMMITMENT',residuePolicy:'RETAIN_AS_LIABILITY',emergencyUnwind:'DISABLED',captainTopUps:false,mode:'PAPER',demo:true};
   const termsHash=createHash('sha256').update(JSON.stringify(terms)).digest('hex');
   await client.query(`INSERT INTO users(id,auth_subject,display_name,username,role,bio,created_at) VALUES($1,$2,$3,$4,'captain',$5,$6)`,
    [c.captainId,`demo:discovery:v1:${c.key}`,`${c.name} · Demo`,`demo_${c.key.replaceAll('-','_')}`,'DEMO: fictional Captain. Simulated performance inspired by public vault P&L shapes; no real trading activity.',fundingStart]);
   await client.query(`INSERT INTO funds(id,captain_id,name,description,status,round_model_version,cash_usdc,total_shares,created_at)
    VALUES($1,$2,$3,$4,$5,2,$6,$6,$7)`,[c.fundId,c.captainId,`${c.vault} · Demo`,'DEMO ONLY: synthetic paper NAV history. Read-only preview; contributions are disabled.',isNew?'FROZEN':'ACTIVE',c.capital,fundingStart]);
   await client.query(`INSERT INTO vault_rounds(fund_id,balance_source,terms_version,terms,terms_hash,phase,funding_window_hours,duration_days,funding_started_at,funding_closes_at,trading_ends_at,actual_activated_at,accepted_capital_usdc,blocked_reason)
    VALUES($1,'LEGACY',1,$2,$3,$4,72,90,$5,$6,$7,$8,$9,'demo_read_only')`,[c.fundId,terms,termsHash,isNew?'FUNDRAISING':'ACTIVE',fundingStart,close,end,isNew?null:close,c.capital]);
   await client.query(`INSERT INTO fund_policy_versions(fund_id,version,max_order_bps,max_position_bps,drawdown_breaker_bps,allowed_instruments,effective_at)
    VALUES($1,1,1000,2500,3000,ARRAY['SOL'],$2)`,[c.fundId,fundingStart]);
   await client.query('INSERT INTO discovery_demo_seeds(captain_id,fund_id,media_key,reference) VALUES($1,$2,$3,$4)',[c.captainId,c.fundId,c.key,{...c.reference,source:provenance.source,retrievedAt:provenance.retrievedAt,methodology:provenance.methodology,portrait:c.portrait}]);
   const fundAccount=await ledgerAccountId(client,'FUND',c.fundId,'USDC');
   const cashIssuance=await ledgerAccountId(client,'ISSUANCE','demo-discovery-budget','USDC');
   const shareIssuance=await ledgerAccountId(client,'ISSUANCE',c.fundId,`SHARE:${c.fundId}`);
   let sequence=0;
   const event=async(type,payload,at)=>{const id=randomUUID();await client.query('INSERT INTO fund_events(id,fund_id,sequence,type,payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6)',[id,c.fundId,++sequence,type,{...payload,isDemo:true},at]);return id;};
   const crewMicro=BigInt(c.capital-100)*1000000n,each=crewMicro/BigInt(c.crew);
   for(let member=0;member<=c.crew;member++){
    const user=member===0?c.captainId:crewIds[member-1];
    const micro=member===0?100000000n:member===c.crew?crewMicro-each*BigInt(c.crew-1):each;
    const amount=`${micro/1000000n}.${String(micro%1000000n).padStart(6,'0')}`;
    const id=await event(member===0?'vault_created':'vault_contributed',{userId:user,amountUsdc:amount,termsHash},fundingStart);
    await client.query('INSERT INTO vault_contributions(id,fund_id,user_id,amount_usdc,event_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),c.fundId,user,amount,id]);
    await client.query('INSERT INTO fund_shares(fund_id,user_id,shares) VALUES($1,$2,$3)',[c.fundId,user,amount]);
    const cash=await ledgerAccountId(client,'USER',user,'USDC'),shares=await ledgerAccountId(client,'USER',user,`SHARE:${c.fundId}`);
    // Grant-and-spend the virtual budget in the same event. User cash remains 0.
    await client.query(`INSERT INTO ledger_entries(event_id,account_id,amount) VALUES
     ($1,$2,-$6::numeric),($1,$3,$6),($1,$3,-$6::numeric),($1,$4,$6),($1,$5,$6),($1,$7,-$6::numeric)`,[id,cashIssuance,cash,fundAccount,shares,amount,shareIssuance]);
   }
   // Initial funding mark followed by public curve samples scaled to our cap.
   const referenceBase=new Amount(c.reference.tvlUsdc).minus(c.reference.monthPnlSamplesUsdc.at(-1));
   const samples=isNew?['0']:c.reference.monthPnlSamplesUsdc;
   let previous=new Amount(c.capital);
   const points=[{at:fundingStart,pnl:'0'},...(!isNew?samples.map((pnl,n)=>({at:new Date(now.getTime()-(samples.length-1-n)*30*86400000/(samples.length-1)),pnl})):[])];
   for(const point of points){
    const pnl=referenceBase.gt(0)?new Amount(point.pnl).div(referenceBase).mul(c.capital):new Amount(0);
    const nav=new Amount(fixed(new Amount(c.capital).plus(pnl),6));
    if(nav.lt(0))throw new Error('Reference curve cannot produce negative demo NAV.');
    const delta=nav.minus(previous),id=await event('demo_performance_mark',{source:provenance.source,navUsdc:fixed(nav,6),simulated:true},point.at);
    if(!delta.eq(0)){
     const market=await ledgerAccountId(client,'MARKET','demo-discovery-performance','USDC');
     await client.query('INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,$4),($1,$3,-$4::numeric)',[id,fundAccount,market,fixed(delta,6)]);
    }
    await client.query('UPDATE funds SET cash_usdc=$2,event_sequence=$3 WHERE id=$1',[c.fundId,fixed(nav,6),sequence]);
    await client.query(`INSERT INTO nav_snapshots(id,fund_id,nav_usdc,share_price_usdc,status,priced_at,event_sequence,created_at)
     VALUES($1,$2,$3,$3::numeric/$4::numeric,'CURRENT',$5,$6,$5)`,[randomUUID(),c.fundId,fixed(nav,6),c.capital,point.at,sequence]);
    previous=nav;
   }
  }
  return 'created';
 });
 await refreshCaptainDiscovery(pool,100);
 return {status:outcome,captains:demoCaptains.map(c=>({id:c.captainId,name:c.name,vaultId:c.fundId,mediaKey:c.key}))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.loadEnvFile('.env');
 if(process.env.NODE_ENV==='production'||!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.DATABASE_URL).hostname))throw new Error('Demo seeding is restricted to a local development database.');
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({action:'preview',captains:demoCaptains.map(({reference,...c})=>c),apply:'node scripts/seed-discovery-demo.mjs --apply'},null,2));}
 else {
  const pool=createPool();try{
   await inTransaction(pool,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(72644201)');
    const name='037_discovery_demo.sql';
    if(!(await client.query("SELECT 1 FROM schema_migrations WHERE name='036_captain_discovery.sql'")).rowCount)throw new Error('Apply discovery migration 036 first.');
    if(!(await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount){await client.query(await readFile(new URL(`../packages/db/migrations/${name}`,import.meta.url),'utf8'));await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}
   });
   console.log(JSON.stringify(await seedDiscoveryDemo(pool),null,2));
  }finally{await pool.end();}
 }
}
