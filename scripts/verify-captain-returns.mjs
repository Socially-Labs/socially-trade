import {createPool} from '../packages/db/dist/index.js';
import {captainTradingReturns} from '../apps/api/dist/captain-returns.js';
import {parseTradingReturns} from '../packages/contracts/dist/index.js';
process.loadEnvFile('.env');const pool=createPool();
try{
 const precision=(await pool.query("SELECT max(scale(index_value))::int AS maximum_scale,count(*) FILTER(WHERE scale(index_value)>18)::int AS over_contract_precision FROM captain_return_rollups")).rows[0];
 console.log('Stored return precision:',precision);
 const captains=(await pool.query('SELECT captain_id FROM captain_return_state')).rows;let checked=0;
 const client=await pool.connect();
 try{for(const captain of captains)for(const range of ['7D','30D','90D','ALL']){
  parseTradingReturns(await captainTradingReturns(client,captain.captain_id,range));checked++;
 }}finally{client.release();}
 console.log(`Validated ${checked} persisted Captain return responses against the APK/shared contract.`);
}finally{await pool.end();}
