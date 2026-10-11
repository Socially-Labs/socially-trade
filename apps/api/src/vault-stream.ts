import { requireActor } from './auth.js';
import { privyIdentity } from './privy.js';
import { requireFundReader } from './paper-access.js';
import { ConnectionLeases,type ConnectionLease } from './connection-leases.js';
import { streamQuery } from './stream-db.js';
import type { FastifyInstance } from 'fastify';
import type { DbPool } from '@socially/db';
import type { WebSocket } from 'ws';
import { envInteger } from '@socially/domain';
import { ApiFault } from './errors.js';

type Subscriber = { actor:string;expiresAt:number;lease:ConnectionLease; socket: WebSocket; ids: Set<string>; alive: boolean; messages: number; window: number; ip: string };
/** One bounded database scan per gateway tick, shared by every local subscriber.
 * Notifications are invalidations, so reconnect always requires a REST snapshot.
 * Delivery uses PostgreSQL across processes; Redis leases bound admission across gateways.
 */
export function registerVaultStream(app: FastifyInstance, db: () => DbPool) {
  const clients = new Set<Subscriber>();
  const admissions=new WeakMap<object,{actor:string;expiresAt:number;lease:ConnectionLease}>();
  const leases=new ConnectionLeases(db,'vault-ws');
  app.addHook('onError',async request=>{await admissions.get(request)?.lease.release();});
  const sequences = new Map<string,string>();
  let timer: ReturnType<typeof setInterval> | undefined, busy = false, stopped = false;
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
      const rows = ids.size ? (await streamQuery<{ id: string; sequence: string;captain_id:string;members:string[] }>(db(),`SELECT f.id,f.event_sequence::text AS sequence,f.captain_id,ARRAY(SELECT user_id::text FROM fund_shares WHERE fund_id=f.id AND shares>0) AS members
        FROM funds f JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=ANY($1::uuid[])`,[[...ids]])).rows : [];
      const byId=new Map(rows.map(row=>[row.id,row]));
      for(const client of clients){
        if(client.expiresAt<=Date.now()){client.ids.clear();client.socket.close(1008,'Authentication expired');continue;}
        for(const id of client.ids){const row=byId.get(id);if(!row||(row.captain_id!==client.actor&&!row.members.includes(client.actor))){client.ids.delete(id);send(client,{type:'error',code:'vault_forbidden',vaultId:id});}}
      }
      for (const row of rows) {
        if (sequences.get(row.id) === row.sequence) continue;
        sequences.set(row.id,row.sequence);
        for (const client of clients) if (client.ids.has(row.id)) send(client,{ type: 'vault.updated',vaultId: row.id,eventSequence: row.sequence });
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
    if ([...clients].filter(client=>client.ip===req.ip).length>=envInteger('PAPER_VAULT_WS_MAX_PER_IP',10)) throw new ApiFault(429,'connection_limit','Too many vault connections');
    const actor=await requireActor(req,db());
    const identity=await privyIdentity(req.headers.authorization!.slice(7));
    admissions.set(req,{actor:actor.id,expiresAt:identity.expiresAt*1000,lease:await leases.acquire(req.ip,actor.id)});
  } },(socket,request) => {
    const client: Subscriber = { ...admissions.get(request)!,socket,ids: new Set(),alive: true,messages: 0,window: Date.now(),ip: request.ip };
    clients.add(client);
    if (!timer) { timer = setInterval(() => void tick(),1000); timer.unref(); }
    socket.on('pong',() => { client.alive = true; });
    socket.on('error',() => socket.close());
    socket.on('close',() => { clients.delete(client);void client.lease.release(); if (!clients.size && timer) { clearInterval(timer); timer = undefined; sequences.clear(); } });
    let chain=Promise.resolve(),pending=0;
    socket.on('message',(raw,binary) => {
      if (Date.now()-client.window>10_000) { client.window = Date.now(); client.messages = 0; }
      if (binary || ++client.messages>10 || pending>=5) { socket.close(1008,'Message limit exceeded'); return; }
      pending++;chain=chain.then(async()=>{
      try {
        const value: unknown = JSON.parse(raw.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid message');
        const message = value as Record<string,unknown>;
        if (message.type !== 'subscribe' || !Array.isArray(message.vaultIds) || message.vaultIds.length>20 || message.vaultIds.some(id =>
          typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) throw new Error('invalid subscription');
        for(const id of message.vaultIds as string[])await requireFundReader(db(),{id:client.actor},id);
        client.ids = new Set(message.vaultIds as string[]);
        // This message must follow subscription on every connection, even with an unchanged cursor.
        for (const id of client.ids) send(client,{ type: 'resync',vaultId: id,eventSequence: sequences.get(id) ?? '0' });
        void tick();
      } catch { socket.close(1008,'Invalid subscription'); }
      }).catch(()=>socket.close(1013,'Stream unavailable')).finally(()=>{pending--;});
    });
  });
  const heartbeatTimer=setInterval(()=>{for(const client of clients){if(client.expiresAt<=Date.now()||!client.alive){client.socket.terminate();continue;}client.alive=false;client.socket.ping();}},envInteger('PAPER_WS_HEARTBEAT_MS',20000,100));heartbeatTimer.unref();
  const leaseTimer=setInterval(()=>{for(const client of clients)void client.lease.renew().then(ok=>{if(!ok)client.socket.close(1013,'Stream admission expired');});},leases.renewMs);leaseTimer.unref();
  app.addHook('onClose' ,async () => { stopped = true;clearInterval(heartbeatTimer);clearInterval(leaseTimer);leases.close(); if (timer) clearInterval(timer); for (const client of clients) client.socket.terminate(); clients.clear(); });
}
