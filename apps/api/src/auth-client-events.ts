import type { FastifyInstance } from 'fastify';
import { ApiFault } from './errors.js';

/** Pre-login SDK failures cannot carry a bearer token. Treat all reports as unverified. */
export function registerAuthClientEvents(app: FastifyInstance) {
  const limits = new Map<string, { start: number; count: number }>();
  app.post<{ Body: { operation: string; platform: string; code: string; status?: number } }>('/v0/auth/client-events', {
    bodyLimit: 1024,
    schema: { body: { type: 'object', required: ['operation', 'platform', 'code'], additionalProperties: false,
      properties: { operation: { type: 'string', enum: ['send', 'verify', 'oauth', 'logout'] },
        platform: { type: 'string', enum: ['android', 'ios', 'web'] },
        code: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,79}$' },
        status: { type: 'integer', minimum: 400, maximum: 599 } } } },
  }, async (request, reply) => {
    const now = Date.now();
    let limit = limits.get(request.ip);
    if (!limit || now - limit.start >= 60_000) {
      if (limits.size >= 1000) limits.delete(limits.keys().next().value!);
      limit = { start: now, count: 0 }; limits.set(request.ip, limit);
    }
    if (++limit.count > 10) throw new ApiFault(429, 'diagnostic_rate_limited', 'Too many diagnostic reports');
    app.log.warn({ source: 'unverified-mobile-client', authFailure: request.body }, 'Privy client authentication failed');
    reply.code(204).header('cache-control', 'no-store').send();
  });
}
