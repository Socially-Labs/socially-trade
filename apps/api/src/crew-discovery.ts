import type { FastifyInstance } from 'fastify';
import { inTransaction, type DbPool } from '@socially/db';
import { Amount, fixed } from '@socially/domain';
import { captainPortfolio } from './captain-portfolio.js';
import { ApiFault } from './errors.js';
import { captainHistory } from './captain-history.js';

const profileColumns = `u.id,u.display_name AS "displayName",u.username,u.bio,u.avatar_url AS "avatarUrl",u.banner_url AS "bannerUrl",EXISTS(SELECT 1 FROM discovery_demo_seeds d WHERE d.captain_id=u.id) AS "isDemo"`;
const eligible = `(u.role='captain' OR EXISTS(SELECT 1 FROM funds f WHERE f.captain_id=u.id)) AND u.username IS NOT NULL`;
const querySchema = { type: 'object', additionalProperties: false, properties: {
  sort: { type:'string',enum:['RECENT','AUM','CREW','RETURN'] }, query: { type: 'string', maxLength: 80 }, after: { type: 'string', format: 'uuid' },
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$' },
} };
export function registerCrewDiscovery(app: FastifyInstance, db: () => DbPool) {
  app.get<{Querystring: {query?:string;after?:string;limit?:string;sort?:string}}>('/v1/discover/captains', {schema:{querystring:querySchema}}, async (req, reply) => {
    reply.header('cache-control','no-store');
    const limit=Number(req.query.limit ?? 20), query=(req.query.query ?? '').trim().replace(/^@/,'').toLowerCase();
    const rows=(await db().query(`WITH directory AS (SELECT ${profileColumns},u.created_at,
      CASE WHEN m.computed_at>transaction_timestamp()-interval '60 seconds' THEN m.net_return_percent::text ELSE NULL END AS "netReturnPercent",
      CASE WHEN m.computed_at>transaction_timestamp()-interval '60 seconds' THEN m.aum_usdc::text ELSE NULL END AS "aumUsdc",
      COALESCE(m.active_vaults,0) AS "activeVaults",COALESCE(m.total_vaults,0) AS "totalVaults",
      COALESCE(m.crew_members,0) AS "crewMembers",m.computed_at AS "computedAt",
      CASE WHEN m.computed_at>transaction_timestamp()-interval '60 seconds' THEN m.portfolio
        WHEN m.portfolio IS NOT NULL THEN m.portfolio || jsonb_build_object('valuationStatus','STALE','coverage','PARTIAL',
          'aumUsdc',NULL,'netPnlUsdc',NULL,'netReturnPercent',NULL) ELSE NULL END AS performance
      FROM users u LEFT JOIN captain_discovery_metrics m ON m.captain_id=u.id AND m.range='30D'
      WHERE ${eligible} AND ($1::text='' OR strpos(lower(u.username),$1)>0)),
      ranked AS (SELECT *,row_number() OVER(ORDER BY
       CASE WHEN $4='RETURN' THEN "netReturnPercent"::numeric END DESC NULLS LAST,
       CASE WHEN $4='AUM' THEN "aumUsdc"::numeric END DESC NULLS LAST,
       CASE WHEN $4='CREW' THEN "crewMembers" END DESC NULLS LAST,
       created_at DESC,id DESC) AS rank FROM directory)
      SELECT * FROM ranked WHERE ($2::uuid IS NULL OR rank>(SELECT rank FROM ranked WHERE id=$2)) ORDER BY rank LIMIT $3`,[query,req.query.after ?? null,limit+1,req.query.sort ?? 'RECENT'])).rows;
    const page=rows.slice(0,limit), history=await captainHistory(db(),page.map(row=>row.id));
    return {mode:'PAPER',captains:page.map(({rank,created_at,...r})=>({...r,history:history.get(r.id),aumUsdc:r.aumUsdc===null?null:fixed(r.aumUsdc,6),netReturnPercent:r.netReturnPercent===null?null:fixed(r.netReturnPercent,6)})),nextCursor:rows.length>limit?rows[limit-1]!.id:null};
  });
  app.get<{Params:{id:string};Querystring:{range?:'7D'|'30D'|'90D'|'ALL'}}>('/v1/discover/captains/:id', {schema:{
    params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}},
    querystring:{type:'object',additionalProperties:false,properties:{range:{type:'string',enum:['7D','30D','90D','ALL']}}},
  }},async(req,reply)=>{
    reply.header('cache-control','no-store');
    return inTransaction(db(),async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const captain=(await client.query(`SELECT ${profileColumns} FROM users u WHERE u.id=$1 AND ${eligible}`,[req.params.id])).rows[0];
      if(!captain)throw new ApiFault(404,'captain_not_found','Captain not found');
      const portfolio=await captainPortfolio(client,captain.id,req.query.range ?? '30D');
      let maxDrawdownPercent: string|null=null;
      if(portfolio.coverage==='COMPLETE' && portfolio.points.length>=2 && portfolio.points.every(p=>!p.hasGap && p.netReturnPercent!==null) && new Set(portfolio.points.map(p=>p.segment)).size===1){
        let peak=new Amount(100), worst=new Amount(0);
        for(const p of portfolio.points){const value=new Amount(100).plus(p.netReturnPercent!);if(value.gt(peak))peak=value;const loss=new Amount(1).minus(value.div(peak)).mul(100);if(loss.gt(worst))worst=loss;}
        maxDrawdownPercent=fixed(worst,6);
      }
      const crew=(await client.query(`SELECT count(DISTINCT c.user_id)::integer AS count FROM vault_contributions c JOIN funds f ON f.id=c.fund_id
        JOIN vault_rounds r ON r.fund_id=f.id WHERE f.captain_id=$1 AND c.user_id<>$1 AND c.state='ACCEPTED'
        AND r.phase IN ('FUNDRAISING','ACTIVE','SETTLING','REFUNDING')`,[captain.id])).rows[0]!.count;
      // Public allowlist: never expose private balances, earnings or member identities.
      const history=await captainHistory(client,[captain.id]);
      return {captain:{...captain,history:history.get(captain.id),crewMembers:crew,activeVaults:portfolio.activeVaults,totalVaults:portfolio.totalVaults,aumUsdc:portfolio.aumUsdc},portfolio,maxDrawdownPercent};
    });
  });
}
