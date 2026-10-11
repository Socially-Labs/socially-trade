import { requireActor } from './auth.js';
import { requireFundReader } from './paper-access.js';
import { ConnectionLeases } from './connection-leases.js';
import { streamQuery } from './stream-db.js';
import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { ApiFault } from "./errors.js";
import { envInteger } from '@socially/domain';
import { getFund } from "./funds.js";
import { sequenceCursor } from "./request.js";

interface FundEvent {
  id: string;
  sequence: string;
  type: string;
  payload: Record<string, unknown>;
  recorded_at: Date;
}

async function readEvents(pool: DbPool, fundId: string, after: number): Promise<FundEvent[]> {
  const result = await streamQuery<FundEvent>(pool,
    `SELECT id, sequence::text, type, payload, recorded_at FROM fund_events
     WHERE fund_id = $1 AND sequence > $2 ORDER BY fund_events.sequence ASC LIMIT 100`,
    [fundId, after],
  );
  const allowed=['orderId','side','instrumentId','notionalUsdc','quantity','marketPriceUsdc','fillPriceUsdc','feeUsdc','modelVersion','observationId','reason','stage','proceedsUsdc','priceSource','priceSourceAt','priceAgeMs','pricingPolicy','unwindCostBps','bidPriceUsdc','askPriceUsdc','pricingModel','modelParameters','realizedPnlUsdc','costBasisSoldUsdc'];
  return result.rows.map(row=>({...row,payload:Object.fromEntries(Object.entries(row.payload).filter(([key])=>allowed.includes(key)))}));
}

export function registerFundEventRoutes(app: FastifyInstance, db: () => DbPool): void {
  const leases=new ConnectionLeases(db,'sse');
  const streams=new Set<()=>void>();
  app.addHook('preClose',async()=>{for(const close of streams)close();});
  app.addHook('onClose',async()=>leases.close());
  app.get<{ Params: { fundId: string }; Querystring: { after?: string } }>(
    "/v0/funds/:fundId/events", async (request) => {
      const actor=await requireActor(request,db());
      await requireFundReader(db(),actor,request.params.fundId);
      const after = sequenceCursor(request.query.after);
      await getFund(db(), request.params.fundId);
      return { mode: "PAPER", events: await readEvents(db(), request.params.fundId, after) };
    },
  );

  app.get<{ Params: { fundId: string }; Querystring: { after?: string } }>(
    "/v0/funds/:fundId/events/stream", async (request, reply) => {
      const lastEventId = request.headers["last-event-id"];
      if (Array.isArray(lastEventId)) throw new ApiFault(400, "invalid_cursor", "Last-Event-ID must be singular");
      let after = sequenceCursor(lastEventId ?? request.query.after);
      const pool = db();
      const actor=await requireActor(request,pool);
      await requireFundReader(pool,actor,request.params.fundId);
      await getFund(pool, request.params.fundId);
      const lease=await leases.acquire(request.ip,actor.id);
      const {privyIdentity}=await import('./privy.js');
      const expiresAt=(await privyIdentity(request.headers.authorization!.slice(7))).expiresAt*1000;
      const expiry=setTimeout(()=>reply.raw.end(),Math.max(0,expiresAt-Date.now()));expiry.unref();
      const renew=setInterval(()=>{void lease.renew().then(ok=>{if(!ok)reply.raw.end();});},leases.renewMs);renew.unref();
      const close=()=>{reply.raw.end();reply.raw.destroy();};streams.add(close);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.write(`: connected to PAPER fund ${request.params.fundId}\n\n`);
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      reply.raw.on("close", () => {
        closed = true;
        streams.delete(close);clearTimeout(expiry);clearInterval(renew);void lease.release();
        if (timer) clearTimeout(timer);
      });

      const poll = async (): Promise<void> => {
        if (closed) return;
        try {
          // Disconnect slow readers before the HTTP buffer grows without bound.
          if(reply.raw.writableLength>envInteger('PAPER_SSE_MAX_BUFFER_BYTES',262144)){close();return;}
          await requireFundReader(pool,actor,request.params.fundId);
          const events = await readEvents(pool, request.params.fundId, after);
          for (const event of events) {
            if (closed) return;
            if(reply.raw.writableLength>envInteger('PAPER_SSE_MAX_BUFFER_BYTES',262144)){close();return;}
            reply.raw.write(`id: ${event.sequence}\nevent: fund-event\ndata: ${JSON.stringify({
              mode: "PAPER", ...event,
            })}\n\n`);
            after = Number(event.sequence);
          }
          if (events.length === 0) reply.raw.write(": heartbeat\n\n");
          timer = setTimeout(() => void poll(), events.length === 100 ? 0 : 2_000);
        } catch (error) {
          app.log.error(error, "Fund event stream failed");
          if (!closed) {reply.raw.write('event: stream_unavailable\ndata: {"error":"stream_unavailable"}\n\n');reply.raw.end();}
        }
      };
      void poll();
    },
  );
}
