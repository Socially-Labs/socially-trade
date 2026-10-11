import { readFile } from 'node:fs/promises';
import { createPool, inTransaction, refreshCaptainDiscovery } from '../packages/db/dist/index.js';
process.loadEnvFile('.env');
if(process.env.NODE_ENV==='production'||!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.DATABASE_URL).hostname))throw new Error('This maintenance helper is restricted to a local development database.');
const pool=createPool();
try {
 if(process.argv.includes('--migrate'))await inTransaction(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(72644201)');
  if(!(await client.query("SELECT 1 FROM schema_migrations WHERE name='035_captain_portfolio.sql'")).rowCount)throw new Error('Apply the Captain portfolio migration first.');
  const name='036_captain_discovery.sql';
  if(!(await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount){
   await client.query(await readFile(new URL(`../packages/db/migrations/${name}`,import.meta.url),'utf8'));
   await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
   console.log(`Applied ${name}`);
  }
 });
 let total=0;
 for(let i=0;i<100;i++){const n=await refreshCaptainDiscovery(pool,20);total+=n;if(!n)break;}
 console.log(`Refreshed ${total} Captain discovery projections.`);
}finally{await pool.end();}
