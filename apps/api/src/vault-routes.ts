import { paperCashColumn } from './paper-portfolio.js';
import { vaultPerformance } from './vault-performance.js';
import type { FastifyInstance } from 'fastify';
import type { DbPool } from '@socially/db';
import { vaultCreateSchema, vaultContributionSchema, vaultPhases, type VaultCreateInput } from '@socially/contracts';
import { contributionReason, fixed } from '@socially/domain';
import { requireActor } from './auth.js';
import { previewOrder,submitOrder,getOrder,cancelOrder,type OrderInput } from './orders.js';
import { idempotencyKey } from './request.js';
import { vaultConfig, vaultDetail, vaultList, vaultPosition, createVault, contributeVault, cancelContribution, claimVault, getVaultOperation } from './vaults.js';

const uuid = { type: 'string', pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' };
const params = { type: 'object', required: ['id'], properties: { id: uuid } };
const page = { type: 'object', additionalProperties: false, properties: {
  after: uuid, limit: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$' },
  phase: { type: 'string', enum: vaultPhases }, durationGroup: { type: 'string', enum: ['short','long'] },
} };
const empty = { type: 'object', additionalProperties: false, maxProperties: 0 };
export function registerVaultRoutes(app: FastifyInstance, db: () => DbPool) {
  app.get('/v1/vault-config', async (_req,reply) => { reply.header('cache-control','no-store'); return vaultConfig(); });
  app.post<{ Body: VaultCreateInput }>('/v1/vaults/preview',{ schema: { body: vaultCreateSchema } },async (req,reply) => {
    reply.header('cache-control','no-store');
    const actor = await requireActor(req,db());
    const cash=(await db().query(`SELECT ${paperCashColumn()}::text AS cash FROM users WHERE id=$1`,[actor.id])).rows[0]!.cash;
    return { ...vaultConfig(),input: req.body,availableUsdc: fixed(cash,6),
      captainEligible: actor.role === 'captain',seedUsdc: '100.000000', networkCostUsdc: '0.000000' };
  });
  app.post<{ Body: VaultCreateInput }>('/v1/vaults',{ schema: { body: vaultCreateSchema } },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store');
    const result = await createVault(db(),actor,req.body,idempotencyKey(req.headers['idempotency-key'])); reply.code(201); return result;
  });
  app.get<{ Querystring: { after?: string; limit?: string; phase?: string; durationGroup?: string } }>('/v1/vaults',{ schema: { querystring: page } },async req =>
    vaultList(db(),{ ...req.query,limit: Number(req.query.limit ?? 20) }));
  app.get<{ Querystring: { after?: string; limit?: string; phase?: string; durationGroup?: string } }>('/v1/me/vaults',{ schema: { querystring: page } },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store');
    return vaultList(db(),{ ...req.query,limit: Number(req.query.limit ?? 20) },actor.id);
  });
  app.get<{ Querystring: { after?: string; limit?: string; phase?: string; durationGroup?: string } }>('/v1/me/captain/vaults',{ schema:{ querystring:page } },async (req,reply) => {
    const actor=await requireActor(req,db()); reply.header('cache-control','no-store');
    return vaultList(db(),{ ...req.query,limit:Number(req.query.limit??20) },actor.id,true);
  });
  app.get<{ Params: { id: string } }>('/v1/vaults/:id',{ schema: { params } },async (req,reply) => {
    reply.header('cache-control','no-store'); return vaultDetail(db(),req.params.id);
  });
  app.get<{ Params: { id: string } }>('/v1/vaults/:id/position',{ schema: { params } },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store'); return vaultPosition(db(),actor,req.params.id);
  });
  app.post<{ Params: { id: string }; Body: { amountUsdc: string; termsHash: string } }>('/v1/vaults/:id/contribution-quotes',{
    schema: { params,body: vaultContributionSchema },
  },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store');
    const vault = await vaultDetail(db(),req.params.id);
    const reason = req.body.termsHash !== vault.termsHash ? 'terms_changed' : contributionReason({
      phase: vault.phase,now: Date.parse(vault.serverTime),fundingClosesAt: Date.parse(vault.fundingClosesAt),
      acceptedCapitalUsdc: vault.acceptedCapitalUsdc,amountUsdc: req.body.amountUsdc,isCaptain: vault.captainId === actor.id });
    return { vaultId: vault.id,amountUsdc: fixed(req.body.amountUsdc,6),shares: fixed(req.body.amountUsdc,6),termsHash: vault.termsHash,
      allowed: reason === null,reason,remainingCapacityUsdc: vault.remainingCapacityUsdc,reserved: false,serverTime: vault.serverTime };
  });
  app.post<{ Params: { id: string }; Body: { amountUsdc: string; termsHash: string } }>('/v1/vaults/:id/contributions',{
    schema: { params,body: vaultContributionSchema },
  },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store');
    const result = await contributeVault(db(),actor,req.params.id,req.body.amountUsdc,req.body.termsHash,idempotencyKey(req.headers['idempotency-key'])); reply.code(201); return result;
  });
  for (const [path,action] of [['contribution-cancellations',cancelContribution],['claims',claimVault]] as const) {
    app.post<{ Params: { id: string }; Body: Record<string, never> }>(`/v1/vaults/:id/${path}`,{ schema: { params,body: empty } },async (req,reply) => {
      const actor = await requireActor(req,db()); reply.header('cache-control','no-store');
      return action(db(),actor,req.params.id,idempotencyKey(req.headers['idempotency-key']));
    });
  }
  app.get<{ Params: { id: string } }>('/v1/operations/:id',{ schema: { params } },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store'); return getVaultOperation(db(),actor.id,req.params.id);
  });
  app.get<{ Querystring: { clientRequestId: string } }>('/v1/me/operations',{ schema: { querystring: {
    type: 'object',required: ['clientRequestId'],additionalProperties: false,properties: { clientRequestId: { type: 'string',minLength: 8,maxLength: 128 } },
  } } },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store'); return getVaultOperation(db(),actor.id,undefined,req.query.clientRequestId);
  });
  app.get<{ Params: { id: string }; Querystring: { range?: '7D'|'30D'|'ALL' } }>('/v1/vaults/:id/performance',{ schema: { params,querystring: {
    type:'object',additionalProperties:false,properties:{ range:{ type:'string',enum:['7D','30D','ALL'] } },
  } } },async req => vaultPerformance(db(),req.params.id,req.query.range ?? '30D'));
  const orderBody = { type: 'object',additionalProperties: false,required: ['side','instrumentId'],properties: {
    side: { type: 'string',enum: ['BUY','SELL'] },instrumentId: { type: 'string',minLength: 1,maxLength: 32 },
    notionalUsdc: { type: 'string',maxLength: 40 },quantity: { type: 'string',maxLength: 40 },
  },oneOf: [{ required: ['notionalUsdc'],not: { required: ['quantity'] } },
    { required: ['quantity'],not: { required: ['notionalUsdc'] },properties: { side: { const: 'SELL' } } }] };
  for (const preview of [true,false]) app.post<{ Params: { id: string }; Body: OrderInput }>(`/v1/vaults/:id/orders${preview ? '/preview' : ''}`,
    { schema: { params,body: orderBody } },async (req,reply) => {
      const actor = await requireActor(req,db()); reply.header('cache-control','no-store');
      await vaultDetail(db(),req.params.id);
      if (preview) return previewOrder(db(),actor,req.params.id,req.body);
      const result = await submitOrder(db(),actor,req.params.id,req.body,idempotencyKey(req.headers['idempotency-key'])); reply.code(202); return result;
    });
  const orderParams = { type: 'object',required: ['id','orderId'],properties: { id: uuid,orderId: uuid } };
  app.get<{ Params: { id: string; orderId: string } }>('/v1/vaults/:id/orders/:orderId',{ schema: { params: orderParams } },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store');
    await vaultPosition(db(),actor,req.params.id);
    return { mode: 'PAPER',order: await getOrder(db(),req.params.id,req.params.orderId) };
  });
  app.post<{ Params: { id: string; orderId: string } }>('/v1/vaults/:id/orders/:orderId/cancel',{ schema: { params: orderParams } },async (req,reply) => {
    const actor = await requireActor(req,db()); reply.header('cache-control','no-store'); await vaultDetail(db(),req.params.id);
    return cancelOrder(db(),actor,req.params.id,req.params.orderId);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/v1/vaults/:id/activity',{ schema: { params,querystring: {
    type: 'object',additionalProperties: false,properties: { after: { type: 'string',pattern: '^(0|[1-9][0-9]{0,17})$' } },
  } } },async req => {
    await vaultDetail(db(),req.params.id);
    // Deliberately select no payload: old payloads contain private membership/payout information.
    const rows = (await db().query(`SELECT id,sequence::text,type,recorded_at AS "recordedAt" FROM fund_events
      WHERE fund_id=$1 AND sequence>$2 AND type IN ('vault_created','vault_active','vault_settling','vault_refunding','vault_finalized','order_filled')
      ORDER BY sequence LIMIT 51`,[req.params.id,req.query.after ?? '0'])).rows;
    return { events: rows.slice(0,50),nextCursor: rows.length>50 ? rows[49]!.sequence : null };
  });
}
