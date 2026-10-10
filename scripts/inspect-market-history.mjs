import { createPool } from '../packages/db/dist/index.js';
import { supportedTokens } from '../packages/market-data/dist/catalog.js';
import { readHistory } from '../packages/market-data/dist/history.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPool();
try {
  const coverage=[];
  for (const token of supportedTokens) {
    const extent=(await pool.query('SELECT min(source_at) AS first,max(source_at) AS last,count(*)::text AS samples FROM market_samples WHERE instrument_id=$1',[token.id])).rows[0];
    const seven=await readHistory(pool,token.mint,'7D'),thirty=await readHistory(pool,token.mint,'30D');
    coverage.push({instrument:token.id,...extent,sevenDay:seven.coverage.status,thirtyDay:thirty.coverage.status});
  }
  console.log(JSON.stringify({measuredAt:new Date().toISOString(),coverage},null,2));
} finally {await pool.end();}
