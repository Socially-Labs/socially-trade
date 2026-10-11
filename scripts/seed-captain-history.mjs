import { createHash, randomUUID } from 'node:crypto';
import { createPool, inTransaction, ledgerAccountId, refreshCaptainDiscovery } from '../packages/db/dist/index.js';
import { Amount, fixed, roundSettlement, VAULT_RULES } from '../packages/domain/dist/index.js';
import { demoId, refreshSeedPresentation } from './seed-discovery-demo.mjs';

// Opt-in local PAPER fixtures. Never alter existing vaults, wallet balances, or live trades.
const fixtures = [
 { key:'horizon-momentum',name:'Horizon Momentum',capital:8000,quantity:20,prices:[115,120,130],age:110 },
 { key:'coastal-growth',name:'Coastal Growth',capital:12000,quantity:30,prices:[120,125,135],age:75 },
 { key:'golden-current',name:'Golden Current',capital:18000,quantity:40,prices:[125,135,145],age:40 },
];
process.loadEnvFile('.env');
if(process.env.NODE_ENV==='production'||!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.DATABASE_URL).hostname))
 throw new Error('Captain history seeding is restricted to a local development database.');
const username=process.argv.find(a=>a.startsWith('--username='))?.split('=')[1]??'vikas';
if(!process.argv.includes('--apply')) {
 console.log(JSON.stringify({action:'preview',username,mode:'PAPER',vaults:fixtures,apply:`node scripts/seed-captain-history.mjs --username=${username} --apply`},null,2));
} else {
 const pool=createPool();
 try {
  const result=await inTransaction(pool,async client=>{
   await client.query("SET LOCAL statement_timeout='30s'");
   await client.query('SELECT pg_advisory_xact_lock(3691038)');
   const captain=(await client.query("SELECT id FROM users WHERE lower(username)=lower($1) AND role='captain' FOR UPDATE",[username])).rows[0];
   if(!captain)throw new Error(`Captain @${username} not found`);
   const instrument=(await client.query("SELECT id FROM instruments WHERE id='SOL'",[])).rows[0];
   if(!instrument)throw new Error('SOL instrument is required');
   const now=new Date(),summary=[];
   for(const f of fixtures){
    const id=demoId(`captain-history:v1:${captain.id}:${f.key}`);
    const existing=(await client.query('SELECT captain_id,description FROM funds WHERE id=$1',[id])).rows[0];
    const description='A completed paper trading strategy with simulated trade history.';
    if(existing){
     if(existing.captain_id!==captain.id||existing.description!==description)throw new Error('Unexpected fixture ownership');
     summary.push({id,name:f.name,status:'already present'});continue;
    }
    const start=new Date(now.getTime()-f.age*86400000),active=new Date(start.getTime()+72*3600000),end=new Date(active.getTime()+28*86400000);
    const terms={...VAULT_RULES,universeMode:'LEGACY_ALLOWLIST',fundingWindowHours:72,durationDays:28,mode:'PAPER',simulated:true,seed:'captain-history:v1',captainTopUps:false};
    const hash=createHash('sha256').update(JSON.stringify(terms)).digest('hex');
    const profit=f.prices.reduce((sum,p)=>sum+(p-100)*f.quantity,0),assets=f.capital+profit;
    const settlement=roundSettlement(String(f.capital),String(assets));
    const price=fixed(new Amount(settlement.distributionPoolUsdc).div(f.capital),18);
    // Insert terminal rounds directly, so the active-vault uniqueness rule remains intact.
    await client.query(`INSERT INTO funds(id,captain_id,name,description,status,round_model_version,cash_usdc,total_shares,created_at,final_nav_usdc,final_share_price_usdc)
     VALUES($1,$2,$3,$4,'COMPLETED',2,$5,$6,$7,$8,$9)`,[id,captain.id,f.name,description,assets,f.capital,start,settlement.distributionPoolUsdc,price]);
    await client.query(`INSERT INTO vault_rounds(fund_id,balance_source,terms_version,terms,terms_hash,phase,funding_window_hours,duration_days,funding_started_at,funding_closes_at,trading_ends_at,actual_activated_at,accepted_capital_usdc,final_supply,final_assets_usdc,distribution_pool_usdc,captain_fee_usdc,residue_liability_usdc,finalized_at)
     VALUES($1,'LEGACY',1,$2,$3,'COMPLETED',72,28,$4,$5,$6,$5,$7,$7,$8,$9,$10,0,$6)`,[id,terms,hash,start,active,end,f.capital,assets,settlement.distributionPoolUsdc,settlement.captainFeeUsdc]);
    await client.query(`INSERT INTO fund_policy_versions(fund_id,version,max_order_bps,max_position_bps,drawdown_breaker_bps,allowed_instruments,effective_at)
     VALUES($1,1,2500,5000,3000,ARRAY['SOL'],$2)`,[id,start]);
    let sequence=0;
    const event=async(type,payload,at)=>{
     const eventId=randomUUID();
     await client.query('INSERT INTO fund_events(id,fund_id,sequence,type,payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6)',[eventId,id,++sequence,type,{...payload,simulated:true,seed:'captain-history:v1'},at]);
     return eventId;
    };
    const account=(type,owner,asset)=>ledgerAccountId(client,type,owner,asset);
    const cash=await account('FUND',id,'USDC'),issuance=await account('ISSUANCE','captain-history-budget','USDC');
    const marketCash=await account('MARKET','captain-history','USDC');
    const asset=await account('FUND',id,'SOL'),marketAsset=await account('MARKET','captain-history','SOL');
    const move=async(e,from,to,amount)=>client.query('INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)',[e,from,to,amount]);
    const crewId=demoId(`captain-history:crew:${captain.id}`);
    await client.query(`INSERT INTO users(id,auth_subject,display_name,username,role,bio) VALUES($1,$2,'Harbor Crew',$3,'crew','Paper trading crew member.') ON CONFLICT(id) DO NOTHING`,[crewId,`seed:captain-history:${captain.id}`,`harbor_${captain.id.slice(0,8)}`]);
    for(const [user,amount] of [[captain.id,100],[crewId,f.capital-100]]){
     const e=await event(user===captain.id?'vault_created':'vault_contributed',{userId:user,amountUsdc:String(amount),termsHash:hash},start);
     const userCash=await account('USER',user,'USDC');
     await move(e,issuance,userCash,amount);await move(e,userCash,cash,amount);
     await move(e,await account('ISSUANCE',id,`SHARE:${id}`),await account('USER',user,`SHARE:${id}`),amount);
     await client.query('INSERT INTO fund_shares(fund_id,user_id,shares) VALUES($1,$2,$3)',[id,user,amount]);
     await client.query('INSERT INTO vault_contributions(id,fund_id,user_id,amount_usdc,event_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,user,amount,e]);
    }
    const mark=async(nav,at,unitPrice=fixed(new Amount(nav).div(f.capital),18))=>{
     await client.query('UPDATE funds SET event_sequence=$2 WHERE id=$1',[id,sequence]);
     await client.query(`INSERT INTO nav_snapshots(id,fund_id,nav_usdc,share_price_usdc,status,priced_at,created_at,event_sequence)
      VALUES($1,$2,$3,$4,'CURRENT',$5,$5,$6)`,[randomUUID(),id,nav,unitPrice,at,sequence]);
    };
    await mark(f.capital,start);
    let nav=f.capital;
    for(const [i,sellPrice] of f.prices.entries()){
     for(const side of ['BUY','SELL']){
      const at=new Date(active.getTime()+(i*8+(side==='BUY'?1:6))*86400000);
      const fillPrice=side==='BUY'?100:sellPrice,notional=fillPrice*f.quantity,order=randomUUID(),observation=randomUUID();
      await client.query(`INSERT INTO price_observations(id,instrument_id,source,source_ref,price_usdc,source_at,received_at)
       VALUES($1,'SOL','SEED_CAPTAIN_HISTORY',$2,$3,$4,$4)`,[observation,`simulated:${id}:${i}:${side}`,fillPrice,at]);
      await client.query(`INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc,status,submitted_at,processed_at,policy_version,progress_state,progress_at)
       VALUES($1,$2,$3,$4,$5,'SOL',$6,'FILLED',$7,$7,1,'FILLED',$7)`,[order,id,captain.id,`seed-history:${id}:${i}:${side}`,side,notional,at]);
      const pnl=side==='SELL'?(sellPrice-100)*f.quantity:0;
      await client.query(`INSERT INTO fills(id,order_id,observation_id,quantity,market_price_usdc,fill_price_usdc,fee_usdc,model_version,filled_at,model_parameters,realized_pnl_usdc,cost_basis_sold_usdc)
       VALUES($1,$2,$3,$4,$5,$5,0,1,$6,$7,$8,$9)`,[randomUUID(),order,observation,f.quantity,fillPrice,at,{simulated:true,seed:'captain-history:v1',feesBps:0},pnl,side==='SELL'?f.quantity*100:0]);
      const e=await event('order_filled',{orderId:order,side,instrumentId:'SOL',quantity:String(f.quantity),fillPriceUsdc:String(fillPrice),realizedPnlUsdc:String(pnl)},at);
      await move(e,side==='BUY'?cash:marketCash,side==='BUY'?marketCash:cash,notional);
      await move(e,side==='BUY'?marketAsset:asset,side==='BUY'?asset:marketAsset,f.quantity);
      if(side==='SELL'){nav+=pnl;await mark(nav,at);}
     }
    }
    await client.query("INSERT INTO positions(fund_id,instrument_id,quantity,cost_basis_usdc) VALUES($1,'SOL',0,0)",[id]);
    await event('vault_finalized',{...settlement,finalAssetsUsdc:String(assets)},end);
    await mark(settlement.distributionPoolUsdc,end,price);
    summary.push({id,name:f.name,status:'created',principalUsdc:f.capital,profitUsdc:profit,netProfitUsdc:Number(settlement.distributionPoolUsdc)-f.capital});
   }
   await refreshSeedPresentation(client);
   // Validate terminal settlement, historical fills, and cash/share/asset accounting before commit.
   const ids=fixtures.map(f=>demoId(`captain-history:v1:${captain.id}:${f.key}`));
   const bad=(await client.query(`SELECT f.id FROM funds f JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=ANY($1::uuid[]) AND
    (r.phase<>'COMPLETED' OR r.final_assets_usdc<>f.cash_usdc OR r.final_assets_usdc<>r.distribution_pool_usdc+r.captain_fee_usdc
     OR f.total_shares<>(SELECT sum(shares) FROM fund_shares WHERE fund_id=f.id)
     OR f.cash_usdc<>(SELECT sum(e.amount) FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.owner_type='FUND' AND a.owner_id=f.id::text AND a.asset_id='USDC')
     OR (SELECT count(*) FROM orders WHERE fund_id=f.id AND status='FILLED')<>6
     OR r.final_assets_usdc-r.accepted_capital_usdc<>(SELECT sum(fl.realized_pnl_usdc) FROM fills fl JOIN orders o ON o.id=fl.order_id WHERE o.fund_id=f.id)
     OR 0<>(SELECT COALESCE(sum(e.amount),0) FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.owner_type='FUND' AND a.owner_id=f.id::text AND a.asset_id='SOL')
     OR (SELECT count(*) FROM nav_snapshots WHERE fund_id=f.id)<>5)`,[ids])).rows;
   const unbalanced=(await client.query(`SELECT e.event_id,a.asset_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id
    JOIN fund_events fe ON fe.id=e.event_id WHERE fe.fund_id=ANY($1::uuid[]) GROUP BY e.event_id,a.asset_id HAVING sum(e.amount)<>0`,[ids])).rows;
   if(bad.length||unbalanced.length)throw new Error('Seed reconciliation failed; rolling back');
   return {username,mode:'PAPER',vaults:summary,verification:'settlement, cash, shares, trade count, charts and balanced ledger passed'};
  });
  await refreshCaptainDiscovery(pool,100);
  console.log(JSON.stringify(result,null,2));
 } finally {await pool.end();}
}
