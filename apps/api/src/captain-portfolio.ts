import type { FastifyInstance } from 'fastify';
import { inTransaction, captainPortfolio, vaultPerformance, type DbPool } from '@socially/db';
import type { CaptainPortfolioRange } from '@socially/contracts';
import { requireActor } from './auth.js';
import { ApiFault } from './errors.js';
export { captainPortfolio } from '@socially/db';
const rangeProperty = { type: 'string', enum: ['7D', '30D', '90D', 'ALL'] };

export function registerCaptainPortfolioRoutes(app: FastifyInstance, db: () => DbPool) {
  app.get<{ Querystring: { range?: CaptainPortfolioRange } }>('/v1/me/captain/portfolio', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { range: rangeProperty } } },
  }, async (req, reply) => {
    const actor = await requireActor(req, db());
    if (actor.role !== 'captain') throw new ApiFault(403, 'captain_required', 'Choose the Captain role first');
    reply.header('cache-control', 'no-store');
    return inTransaction(db(), async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return captainPortfolio(client, actor.id, req.query.range ?? '30D');
    });
  });
  app.get<{ Querystring: { range?: CaptainPortfolioRange; after?: string; limit?: string } }>('/v1/me/captain/portfolio/vaults', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      range: rangeProperty, after: { type: 'string', format: 'uuid' }, limit: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$' },
    } } },
  }, async (req, reply) => {
    const actor = await requireActor(req, db());
    if (actor.role !== 'captain') throw new ApiFault(403, 'captain_required', 'Choose the Captain role first');
    reply.header('cache-control', 'no-store');
    return inTransaction(db(), async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return vaultPerformance(client, actor.id, req.query.range ?? '30D', req.query.after ?? null, Number(req.query.limit ?? 20));
    });
  });
}
