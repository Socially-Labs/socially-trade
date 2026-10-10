import {createHash} from 'node:crypto';
import {createPool,inTransaction,appendFundEvent} from '../packages/db/dist/index.js';
process.loadEnvFile('.env');
const ids=process.argv.slice(2);if(!ids.length||ids.some(id=>! /^[a-f0-9-]{36}$/i.test(id)))throw new Error('Pass explicit paper fund IDs; completed rounds cannot be changed');
const pool=createPool();
try {
  for(const id of ids)await inTransaction(pool,async client=>{
    const fund=(await client.query("SELECT id,status FROM funds WHERE id=$1 AND mode='PAPER' FOR NO KEY UPDATE",[id])).rows[0];
    if(!fund||fund.status==='COMPLETED')throw new Error('Only open paper funds can opt into dynamic spot markets');
    const policy=(await client.query('SELECT * FROM fund_policy_versions WHERE fund_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
    if(policy.universe_mode==='DYNAMIC_SPOT'){console.log('Already enabled',id);return;}
    const round=(await client.query('SELECT phase,terms,terms_hash FROM vault_rounds WHERE fund_id=$1',[id])).rows[0];
    if(round&&!['FUNDRAISING','ACTIVE'].includes(round.phase))throw new Error('Only open rounds can opt in');
    // No numeric economics change, and every historical policy/accepted order keeps its original version.
    await client.query(`INSERT INTO fund_policy_versions(fund_id,version,max_order_bps,max_position_bps,drawdown_breaker_bps,allowed_instruments,effective_at,universe_mode)
      VALUES($1,$2,$3,$4,$5,$6,now(),'DYNAMIC_SPOT')`,[id,policy.version+1,policy.max_order_bps,policy.max_position_bps,policy.drawdown_breaker_bps,policy.allowed_instruments]);
    let hash=null;
    if(round){const terms={...round.terms,universeMode:'DYNAMIC_SPOT'};hash=createHash('sha256').update(JSON.stringify(terms)).digest('hex');
      await client.query('INSERT INTO vault_universe_amendments(fund_id,policy_version,previous_terms,previous_hash,amended_terms,amended_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,policy.version+1,round.terms,round.terms_hash,terms,hash]);
      await client.query('UPDATE vault_rounds SET terms=$2,terms_hash=$3 WHERE fund_id=$1',[id,terms,hash]);}
    await appendFundEvent(client,id,'asset_universe_changed',{fromVersion:policy.version,toVersion:policy.version+1,universeMode:'DYNAMIC_SPOT',previousTermsHash:round?.terms_hash??null,termsHash:hash});
    console.log('Enabled',id,'policy',policy.version+1);
  });
}finally{await pool.end();}
