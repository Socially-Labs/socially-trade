import { streamQuery } from './stream-db.js';
import type { DbPool } from '@socially/db';
import type { Actor } from './auth.js';
import { ApiFault } from './errors.js';
export async function requireFundReader(pool:DbPool,actor:Pick<Actor,'id'>,fundId:string):Promise<void>{
  const row=(await streamQuery(pool,`SELECT captain_id,EXISTS(SELECT 1 FROM fund_shares WHERE fund_id=f.id AND user_id=$2 AND shares>0) AS member FROM funds f WHERE id=$1`,[fundId,actor.id])).rows[0];
  if(!row)throw new ApiFault(404,'fund_not_found','Fund not found');
  if(row.captain_id!==actor.id&&!row.member)throw new ApiFault(403,'fund_forbidden','Captain or current member access required');
}
