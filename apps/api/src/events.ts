import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { ApiFault } from "./errors.js";
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
  const result = await pool.query<FundEvent>(
    `SELECT id, sequence::text, type, payload, recorded_at FROM fund_events
     WHERE fund_id = $1 AND sequence > $2 ORDER BY fund_events.sequence ASC LIMIT 100`,
    [fundId, after],
  );
  return result.rows;
}

export function registerFundEventRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Params: { fundId: string }; Querystring: { after?: string } }>(
    "/v0/funds/:fundId/events", async (request) => {
      const after = sequenceCursor(request.query.after);
      await getFund(db(), request.params.fundId);
      return { mode: "PAPER", events: await readEvents(db(), request.params.fundId, after) };
    },
  );

  app.get<{ Params: { fundId: string }; Querystring: { after?: string } }>(
    "/v0/funds/:fundId/events/stream", async (request, reply) => {
      const lastEventId = request.headers["last-event-id"];
      if (Array.isArray(lastEventId)) throw new ApiFault(400, "invalid_cursor", "Last-Event-ID must be singular");
      let after = sequenceCursor(request.query.after ?? lastEventId);
      const pool = db();
      await getFund(pool, request.params.fundId);
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
        if (timer) clearTimeout(timer);
      });

      const poll = async (): Promise<void> => {
        if (closed) return;
        try {
          const events = await readEvents(pool, request.params.fundId, after);
          for (const event of events) {
            if (closed) return;
            reply.raw.write(`id: ${event.sequence}\nevent: fund-event\ndata: ${JSON.stringify({
              mode: "PAPER", ...event,
            })}\n\n`);
            after = Number(event.sequence);
          }
          if (events.length === 0) reply.raw.write(": heartbeat\n\n");
          timer = setTimeout(() => void poll(), events.length === 100 ? 0 : 2_000);
        } catch (error) {
          app.log.error(error, "Fund event stream failed");
          if (!closed) reply.raw.end();
        }
      };
      void poll();
    },
  );
}
