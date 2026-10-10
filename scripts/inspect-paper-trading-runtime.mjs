import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createPool} from '../packages/db/dist/index.js';
process.loadEnvFile('.env');const pool=createPool();
try{
 const migrations=(await pool.query("SELECT name FROM schema_migrations WHERE name LIKE '031_%' OR name LIKE '032_%' ORDER BY name")).rows.map(r=>r.name);assert.equal(migrations.length,2);
 const services=[];
 for(const path of ['/health','/admin/paper-trading/health']){
  const response=await fetch('http://127.0.0.1:3000'+path,{headers:process.env.ADMIN_LOGS_TOKEN?{authorization:`Bearer ${process.env.ADMIN_LOGS_TOKEN}`}:{},signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);services.push({path,status:response.status,value:await response.json()});
 }
 const expo=await fetch('http://127.0.0.1:8081/',{signal:AbortSignal.timeout(5000)});assert.equal(expo.status,200);
 const report={at:new Date().toISOString(),migrations,services,expoStatus:expo.status,
  ingestorLeaders:(await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=7810231 AND granted")).rows[0].n,
  valuations:(await pool.query('SELECT count(*)::int AS queued,min(next_run_at) AS earliest_due FROM fund_valuation_jobs')).rows[0],
  returns:(await pool.query('SELECT count(*)::int AS captains FROM captain_return_state')).rows[0],
  capabilities:{privateUpdates:process.env.PAPER_PRIVATE_UPDATES_ENABLED==='true',historyProvider:process.env.MARKET_HISTORY_PROVIDER_ENABLED==='true',historyCredentialPresent:!!process.env.BIRDEYE_API_KEY}};
 assert.equal(report.ingestorLeaders,1);
 await writeFile(new URL('../docs/paper-trading-runtime-evidence.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await pool.end();}
