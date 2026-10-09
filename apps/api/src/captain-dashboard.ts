import { paperCashColumn } from './paper-portfolio.js';
import type { FastifyInstance } from 'fastify';
import { inTransaction, type DbPool } from '@socially/db';
import { Amount, fixed, VAULT_RULES } from '@socially/domain';
import { requireActor, type Actor } from './auth.js';
import { ApiFault } from './errors.js';
import { vaultConfig } from './vaults.js';

function captain(actor: Actor) {
  if (actor.role !== 'captain') throw new ApiFault(403,'captain_required','Choose the Captain role first');
}
const paging = { type:'object',additionalProperties:false,properties:{
  after:{ type:'string',format:'uuid' },limit:{ type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$' },
} };
const openPhases = "('FUNDRAISING','ACTIVE','SETTLING','REFUNDING')";
const crewSql = `SELECT u.id,u.display_name AS "displayName",u.username,u.avatar_url AS "avatarUrl",
 count(DISTINCT c.fund_id)::integer AS "vaultCount",sum(c.amount_usdc)::text AS "allocatedUsdc",min(e.recorded_at) AS "joinedAt"
 FROM vault_contributions c JOIN funds f ON f.id=c.fund_id JOIN vault_rounds r ON r.fund_id=f.id
 JOIN users u ON u.id=c.user_id JOIN fund_events e ON e.id=c.event_id
 WHERE f.captain_id=$1 AND c.user_id<>$1 AND c.state='ACCEPTED' AND r.phase IN ${openPhases}
 GROUP BY u.id`;
export function registerCaptainDashboardRoutes(app: FastifyInstance, db: () => DbPool) {
  app.get('/v1/me/captain/dashboard',async(req,reply)=>{
    const actor=await requireActor(req,db()); captain(actor); reply.header('cache-control','no-store');
    return inTransaction(db(),async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const m=(await client.query(`SELECT count(*)::integer AS "vaultCount",
        count(*) FILTER(WHERE phase='ACTIVE')::integer AS "activeVaults",
        count(*) FILTER(WHERE phase IN ${openPhases})::integer AS "openVaults",
        CASE WHEN bool_or(managed_usdc IS NULL) THEN NULL ELSE COALESCE(sum(managed_usdc),0)::text END AS "aumUsdc",
        COALESCE(sum(captain_fee_usdc),0)::text AS "earnedUsdc",COALESCE(sum(claimed_fee_usdc),0)::text AS "claimedUsdc"
        FROM captain_vault_metrics WHERE captain_id=$1`,[actor.id])).rows[0]!;
      const crew=(await client.query(`SELECT count(*)::integer AS count FROM (${crewSql}) members`,[actor.id])).rows[0]!.count;
      const cash=(await client.query(`SELECT ${paperCashColumn()}::text AS amount FROM users WHERE id=$1`,[actor.id])).rows[0]!.amount;
      const legacy=(await client.query("SELECT 1 FROM funds WHERE captain_id=$1 AND status IN ('ACTIVE','FROZEN') LIMIT 1",[actor.id])).rowCount;
      const config=vaultConfig();
      const creationReason=!config.enabled?'funding_unavailable':legacy?'open_round_exists':new Amount(cash).lt(VAULT_RULES.captainSeedUsdc)?'insufficient_seed':null;
      return { schemaVersion:1,mode:'PAPER',state:m.vaultCount===0?'NEW':'EXISTING',vaultCount:m.vaultCount,
        activeVaults:m.activeVaults,openVaults:m.openVaults,crewMembers:crew,aumUsdc:m.aumUsdc===null?null:fixed(m.aumUsdc,6),
        valuationStatus:m.aumUsdc===null?'UNAVAILABLE':'CURRENT',
        earnings:{ earnedUsdc:fixed(m.earnedUsdc,6),claimedUsdc:fixed(m.claimedUsdc,6),claimableUsdc:fixed(new Amount(m.earnedUsdc).minus(m.claimedUsdc),6) },
        creation:{ allowed:creationReason===null,reason:creationReason,seedUsdc:VAULT_RULES.captainSeedUsdc,availableUsdc:fixed(cash,6) },
        serverTime:new Date().toISOString() };
    });
  });
  app.get<{ Querystring:{ after?:string;limit?:string } }>('/v1/me/captain/crew',{ schema:{ querystring:paging } },async(req,reply)=>{
    const actor=await requireActor(req,db()); captain(actor); reply.header('cache-control','no-store');
    const limit=Number(req.query.limit??20);
    const rows=(await db().query(`WITH members AS (${crewSql}) SELECT * FROM members WHERE ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[actor.id,req.query.after??null,limit+1])).rows;
    return { mode:'PAPER',members:rows.slice(0,limit).map(r=>({...r,allocatedUsdc:fixed(r.allocatedUsdc,6),joinedAt:r.joinedAt.toISOString()})),nextCursor:rows.length>limit?rows[limit-1]!.id:null };
  });
  app.get<{ Querystring:{ after?:string;limit?:string } }>('/v1/me/captain/earnings',{ schema:{ querystring:paging } },async(req,reply)=>{
    const actor=await requireActor(req,db()); captain(actor); reply.header('cache-control','no-store');const limit=Number(req.query.limit??20);
    const rows=(await db().query(`SELECT id,name,phase,finalized_at,captain_fee_usdc::text,claimed_fee_usdc::text,paid_at
      FROM captain_vault_metrics WHERE captain_id=$1 AND finalized_at IS NOT NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[actor.id,req.query.after??null,limit+1])).rows;
    return { mode:'PAPER',earnings:rows.slice(0,limit).map(r=>({ vaultId:r.id,name:r.name,earnedUsdc:fixed(r.captain_fee_usdc,6),claimedUsdc:fixed(r.claimed_fee_usdc,6),
      claimableUsdc:fixed(new Amount(r.captain_fee_usdc).minus(r.claimed_fee_usdc),6),finalizedAt:r.finalized_at.toISOString(),claimedAt:r.paid_at?.toISOString()??null })),nextCursor:rows.length>limit?rows[limit-1]!.id:null };
  });
  app.get<{ Querystring:{ range?:'7D'|'30D'|'90D'|'ALL' } }>('/v1/me/captain/performance',{ schema:{ querystring:{ type:'object',additionalProperties:false,
    properties:{ range:{ type:'string',enum:['7D','30D','90D','ALL'] } } } } },async(req,reply)=>{
    const actor=await requireActor(req,db()); captain(actor);reply.header('cache-control','no-store');
    const range=req.query.range??'30D',sourceSeconds=range==='7D'?3600:86400;
    return inTransaction(db(),async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const oldest=(await client.query('SELECT min(funding_started_at) AS at FROM captain_vault_metrics WHERE captain_id=$1',[actor.id])).rows[0]!.at as Date|null;
      const now=new Date(),start=range==='ALL'?oldest??now:new Date(now.getTime()-Number.parseInt(range)*86400000);
      const seconds=range==='ALL'?Math.max(86400,Math.ceil((now.getTime()-start.getTime())/86400000/400)*86400):sourceSeconds;
      // One last recorded value per vault/bucket. No interpolation or synthetic
      // returns: cash flows and completed rounds change AUM and are labeled as such.
      const rows=(await client.query(`WITH owned AS(SELECT id,funding_started_at,finalized_at FROM captain_vault_metrics WHERE captain_id=$1),
        buckets AS(SELECT DISTINCT to_timestamp(floor(extract(epoch FROM p.bucket_at)/$2)*$2) AS bucket_at FROM captain_vault_aum_rollups p JOIN owned o ON o.id=p.fund_id
          WHERE p.interval_seconds=$4 AND p.bucket_at>=to_timestamp(floor(extract(epoch FROM $3::timestamptz)/$2)*$2) AND p.bucket_at<=clock_timestamp())
        SELECT LEAST(b.bucket_at+$2*interval '1 second',clock_timestamp()) AS at,CASE WHEN bool_or(p.nav_usdc IS NULL) THEN NULL ELSE sum(p.nav_usdc)::text END AS amount
        FROM buckets b JOIN owned o ON o.funding_started_at<b.bucket_at+$2*interval '1 second'
          AND (o.finalized_at IS NULL OR o.finalized_at>=b.bucket_at)
        LEFT JOIN LATERAL(SELECT nav_usdc FROM captain_vault_aum_rollups WHERE fund_id=o.id AND interval_seconds=$4 AND bucket_at<b.bucket_at+$2*interval '1 second' ORDER BY bucket_at DESC LIMIT 1)p ON true
        GROUP BY b.bucket_at ORDER BY b.bucket_at`,[actor.id,seconds,start,sourceSeconds])).rows;
      const points=rows.map(r=>({ at:r.at.toISOString(),aumUsdc:r.amount===null?null:fixed(r.amount,6) }));
      const first=points[0]?.aumUsdc,last=points.at(-1)?.aumUsdc;
      const change=first!=null&&last!=null&&points.every(p=>p.aumUsdc!==null)?new Amount(last).minus(first):null;
      return { mode:'PAPER',range,intervalSeconds:seconds,points,coverage:points.length?'PARTIAL':'UNAVAILABLE',
        changeUsdc:change===null?null:fixed(change,6),changePercent:change===null||first==null||new Amount(first).eq(0)?null:fixed(change.div(first).mul(100),6),
        methodology:'Managed assets across round-v2 vaults. Includes contributions, cancellations and market changes; excludes completed rounds. AUM change is not investment return. Buckets contain last recorded values; missing marks stay unavailable.' };
    });
  });
}
