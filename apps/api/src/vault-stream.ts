import type { FastifyInstance } from 'fastify';
import type { DbPool } from '@socially/db';
import type { WebSocket } from 'ws';
import { ApiFault } from './errors.js';

type Subscriber = { socket: WebSocket; ids: Set<string>; alive: boolean; messages: number; window: number; ip: string };
/** One bounded database scan per gateway tick, shared by every local subscriber.
 * Notifications are invalidations, so reconnect always requires a REST snapshot.
 * This works across worker/API processes without per-client SQL loops or Redis availability.
 */
export function registerVaultStream(app: FastifyInstance, db: () => DbPool) {
  const clients = new Set<Subscriber>();
  const sequences = new Map<string,string>();
  let timer: ReturnType<typeof setInterval> | undefined, busy = false, stopped = false, heartbeat = 0;
  const send = (client: Subscriber,value: unknown) => {
    if (client.socket.readyState !== 1) return;
    if (client.socket.bufferedAmount > 64*1024) { client.socket.close(1013,'Reconnect and resync'); return; }
    client.socket.send(JSON.stringify(value));
  };
  const tick = async () => {
    if (busy || stopped || !clients.size) return;
    busy = true;
    try {
      const ids = new Set([...clients].flatMap(client => [...client.ids]));
      for (const id of sequences.keys()) if (!ids.has(id)) sequences.delete(id);
      const rows = ids.size ? (await db().query<{ id: string; sequence: string }>(`SELECT f.id,f.event_sequence::text AS sequence
        FROM funds f JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=ANY($1::uuid[])`,[[...ids]])).rows : [];
      for (const row of rows) {
        if (sequences.get(row.id) === row.sequence) continue;
        sequences.set(row.id,row.sequence);
        for (const client of clients) if (client.ids.has(row.id)) send(client,{ type: 'vault.updated',vaultId: row.id,eventSequence: row.sequence });
      }
      if (Date.now()-heartbeat > 25_000) {
        heartbeat = Date.now();
        for (const client of clients) {
          if (!client.alive) { client.socket.terminate(); continue; }
          client.alive = false; client.socket.ping();
        }
      }
    } catch (error) {
      app.log.error(error,'Vault stream unavailable');
      // A failed scan is not a successful delivery. Close to force REST fallback and recovery.
      for (const client of clients) client.socket.close(1013,'Resync required');
    } finally { busy = false; }
  };
  app.get('/v1/vaults/ws',{ websocket: true,preValidation: async req => {
    const allowed = (process.env.WS_ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (req.headers.origin && (allowed.length ? !allowed.includes(req.headers.origin) : process.env.NODE_ENV === 'production')) throw new ApiFault(403,'origin_forbidden','WebSocket origin is not allowed');
    if ([...clients].filter(client=>client.ip===req.ip).length>=10) throw new ApiFault(429,'connection_limit','Too many vault connections');
    if (clients.size >= 200) throw new ApiFault(503,'gateway_busy','Vault stream capacity reached');
  } },(socket,request) => {
    const client: Subscriber = { socket,ids: new Set(),alive: true,messages: 0,window: Date.now(),ip: request.ip };
    clients.add(client);
    if (!timer) { timer = setInterval(() => void tick(),1000); timer.unref(); }
    socket.on('pong',() => { client.alive = true; });
    socket.on('error',() => socket.close());
    socket.on('close',() => { clients.delete(client); if (!clients.size && timer) { clearInterval(timer); timer = undefined; sequences.clear(); } });
    socket.on('message',(raw,binary) => {
      if (Date.now()-client.window>10_000) { client.window = Date.now(); client.messages = 0; }
      if (binary || ++client.messages>10) { socket.close(1008,'Message limit exceeded'); return; }
      try {
        const value: unknown = JSON.parse(raw.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid message');
        const message = value as Record<string,unknown>;
        if (message.type !== 'subscribe' || !Array.isArray(message.vaultIds) || message.vaultIds.length>20 || message.vaultIds.some(id =>
          typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) throw new Error('invalid subscription');
        client.ids = new Set(message.vaultIds as string[]);
        // This message must follow subscription on every connection, even with an unchanged cursor.
        for (const id of client.ids) send(client,{ type: 'resync',vaultId: id,eventSequence: sequences.get(id) ?? '0' });
        void tick();
      } catch { socket.close(1008,'Invalid subscription'); }
    });
  });
  app.addHook('onClose',async () => { stopped = true; if (timer) clearInterval(timer); for (const client of clients) client.socket.terminate(); clients.clear(); });
}
