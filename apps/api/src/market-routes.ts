import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { DbPool } from "@socially/db";
import { MarketBus, currentPrice, compareCursor, cursorPattern, type MarketEvent } from "@socially/market-stream";
import { registeredInstruments } from "@socially/market-data/registry";
import { instrumentSubset } from "@socially/market-data/catalog";
import { ApiFault } from "./errors.js";
import { privyIdentity } from "./privy.js";

type Client = { instruments?: string[]; socket: WebSocket; cursor?: string; actor?: string; expiresAt: number; notifications?: string;
  vault?: {id:string; revision:string}; captain?: {revision:string}; alive: boolean; messages: number; window: number; pending: number; chain: Promise<void>; freshness?: string };
const sequence = /^(0|[1-9][0-9]{0,18})$/;
const validSequence = (value: string) => sequence.test(value) && BigInt(value) <= 9223372036854775807n;

/** One polling loop per gateway; market events fan out to all local subscribers. */
export function registerMarketRoutes(app: FastifyInstance, db: () => DbPool): void {
  let bus: MarketBus | undefined;
  const clients = new Set<Client>();
  let stopped = false;
  let busy: Promise<void> | undefined;
  let lastHeartbeat = Date.now();
  const market = () => {
    if (!process.env.REDIS_URL) throw new ApiFault(503, "market_unavailable", "Market streaming requires Redis");
    return bus ??= new MarketBus(db(), process.env.REDIS_URL);
  };
  const send = (client: Client, value: unknown) => {
    if (client.socket.readyState !== 1) return;
    if (client.socket.bufferedAmount > 256 * 1024) { client.socket.close(1013, "Reconnect and resync"); return; }
    client.socket.send(JSON.stringify(value));
  };
  const subset = async (value?: string[]) => {
    if(value===undefined)return instrumentSubset();
    if(!value.length||value.length>50||new Set(value).size!==value.length||value.some(id=>typeof id!=='string'||id.length>64))throw new Error('invalid_instruments');
    const rows=await registeredInstruments(db(),value);
    if(rows.length!==value.length)throw new Error('unknown_instrument');
    return value;
  };
  const selected = (client: Client, prices: import("@socially/market-stream").MarketPrice[]) => prices.filter(p => client.instruments?.includes(p.instrumentId));
  const resync = async (client: Client) => {
    const snapshot = await market().snapshot();
    send(client, { type: "resync_required", channel: "market.prices" });
    send(client, { type: "snapshot", channel: "market.prices", cursor: snapshot.cursor, prices: selected(client, snapshot.prices) });
    client.cursor = snapshot.cursor;
    client.freshness = JSON.stringify(selected(client, snapshot.prices).map(p => [p.instrumentId, p.status]));
  };
  app.get<{ Querystring: { instruments?: string } }>("/v0/market/prices", async (request, reply) => {
    let instruments: string[];
    try { instruments = await subset(request.query.instruments?.split(",")); }
    catch { throw new ApiFault(400, "unsupported_instrument", "Choose supported instruments"); }
    reply.header("cache-control", "no-store");
    try { const snapshot = await market().snapshot(); return { mode: "PAPER", transport: "redis", ...snapshot, prices: snapshot.prices.filter(p => instruments.includes(p.instrumentId)) }; }
    catch {
      const rows = await db().query<{ payload: MarketEvent }>("SELECT payload FROM market_latest ORDER BY instrument_id");
      return { mode: "PAPER", transport: "database", cursor: null,
        prices: rows.rows.map(row => currentPrice(row.payload.price)).filter(p => instruments.includes(p.instrumentId)) };
    }
  });

  app.get("/v0/ws", { websocket: true, preValidation: async (request) => {
    const origin = request.headers.origin;
    const allowed = (process.env.WS_ALLOWED_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean);
    if (origin && (allowed.length ? !allowed.includes(origin) : process.env.NODE_ENV === "production")) {
      throw new ApiFault(403, "origin_forbidden", "WebSocket origin is not allowed");
    }
    if (clients.size >= 1000) throw new ApiFault(503, "gateway_busy", "Try another gateway");
    market();
  } }, (socket) => {
    const client: Client = { socket, expiresAt: 0, alive: true, messages: 0, window: Date.now(), pending: 0, chain: Promise.resolve() };
    clients.add(client);
    socket.on("pong", () => { client.alive = true; });
    socket.on("error", () => socket.close());
    socket.on("close", () => { clients.delete(client); });
    // Attach synchronously before any authentication or subscription awaits.
    socket.on("message", (raw, binary) => {
      if (Date.now() - client.window > 10_000) { client.window = Date.now(); client.messages = 0; }
      if (binary || ++client.messages > 20 || client.pending >= 5) { socket.close(1008, "Message limit exceeded"); return; }
      client.pending++;
      client.chain = client.chain.then(async () => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid_message");
        if (message.type === "authenticate") {
          // Clear previous identity before switching credentials, including failed reauthentication.
          client.actor = undefined; client.notifications = undefined; client.vault = undefined; client.captain=undefined; client.expiresAt = 0;
          if (typeof message.accessToken !== "string") throw new Error("invalid_token");
          const identity = await privyIdentity(message.accessToken);
          const actor = (await db().query<{ id: string }>("SELECT id FROM users WHERE auth_subject=$1", [identity.subject])).rows[0];
          if (!actor) throw new Error("bootstrap_required");
          client.actor = actor.id; client.expiresAt = identity.expiresAt * 1000;
          send(client, { type: "authenticated", expiresAt: new Date(client.expiresAt).toISOString() });
        } else if (message.type === "subscribe" && message.channel === "market.prices") {
          if (message.instruments !== undefined && (!Array.isArray(message.instruments) || message.instruments.some(id => typeof id !== "string"))) throw new Error("unsupported_instrument");
          const instruments = await subset(message.instruments as string[] | undefined);
          const changed = !!client.instruments && (client.instruments.length !== instruments.length || instruments.some(id => !client.instruments!.includes(id)));
          client.freshness = undefined;
          const snapshot = await market().snapshot();
          const after = message.after;
          if (after !== undefined && (typeof after !== "string" || !cursorPattern.test(after))) throw new Error("invalid_cursor");
          client.instruments = instruments;
          if (!changed && typeof after === "string" && compareCursor(after, snapshot.firstCursor) >= 0 && compareCursor(after, snapshot.cursor) <= 0) {
            client.cursor = after; send(client, { type: "subscribed", channel: "market.prices", cursor: after });
          } else {
            if (after !== undefined) send(client, { type: "resync_required", channel: "market.prices" });
            send(client, { type: "snapshot", channel: "market.prices", cursor: snapshot.cursor, prices: selected(client, snapshot.prices) });
            client.cursor = snapshot.cursor;
          }
        } else if(message.type==='subscribe' && message.channel==='vault.context') {
          if(process.env.PAPER_PRIVATE_UPDATES_ENABLED!=='true'||!client.actor||client.expiresAt<=Date.now())throw new Error('authentication_required');
          if(typeof message.vaultId!=='string'||! /^[a-f0-9-]{36}$/i.test(message.vaultId))throw new Error('invalid_vault');
          const row=(await db().query<{revision:string}>(`SELECT f.event_sequence::text AS revision FROM funds f WHERE f.id=$1 AND
            (f.captain_id=$2 OR EXISTS(SELECT 1 FROM fund_shares s WHERE s.fund_id=f.id AND s.user_id=$2 AND s.shares>0))`,[message.vaultId,client.actor])).rows[0];
          if(!row)throw new Error('vault_forbidden');
          client.vault={id:message.vaultId,revision:row.revision};
          // Subscription-first snapshot invalidation closes the REST/subscription race, including expired cursors.
          send(client,{type:'resync_required',channel:'vault.context',vaultId:message.vaultId,accountingRevision:row.revision,cursor:row.revision});
        } else if(message.type==='subscribe' && message.channel==='captain.dashboard') {
          if(process.env.PAPER_PRIVATE_UPDATES_ENABLED!=='true'||!client.actor||client.expiresAt<=Date.now())throw new Error('authentication_required');
          if(message.captainId!==undefined&&message.captainId!==client.actor)throw new Error('captain_forbidden');
          const row=(await db().query("SELECT COALESCE(s.revision,0)::text AS revision FROM users u LEFT JOIN captain_change_state s ON s.captain_id=u.id WHERE u.id=$1 AND u.role='captain'",[client.actor])).rows[0];
          if(!row)throw new Error('captain_required');
          client.captain={revision:row.revision};
          send(client,{type:'resync_required',channel:'captain.dashboard',revision:row.revision,cursor:row.revision});
        } else if (message.type === "subscribe" && message.channel === "account.notifications") {
          if (!client.actor || client.expiresAt <= Date.now()) throw new Error("authentication_required");
          const after = message.after ?? "0";
          if (typeof after !== "string" || !validSequence(after)) throw new Error("invalid_cursor");
          client.notifications = after;
          send(client, { type: "subscribed", channel: "account.notifications", cursor: after });
        } else if (message.type === "unsubscribe") {
          if (message.channel === "market.prices") client.cursor = undefined;
          else if (message.channel === "account.notifications") client.notifications = undefined;
          else if(message.channel=== "vault.context") client.vault=undefined;
          else if(message.channel==='captain.dashboard')client.captain=undefined;
          else throw new Error("unsupported_channel");
        } else throw new Error("unsupported_message");
      }).catch(() => send(client, { type: "error", code: "request_rejected", message: "Check authentication, channel and cursor" }))
        .finally(() => { client.pending--; });
    });
    send(client, { type: "hello", mode: "PAPER", channels: ["market.prices", "account.notifications",...(process.env.PAPER_PRIVATE_UPDATES_ENABLED==='true'?["vault.context","captain.dashboard"]:[])] });
  });

  async function tick() {
    const now = Date.now();
    if (now - lastHeartbeat >= 20_000) {
      lastHeartbeat = now;
      for (const client of clients) {
        if (!client.alive) { client.socket.terminate(); continue; }
        client.alive = false; client.socket.ping();
      }
    }
    for (const client of clients) if (client.actor && client.expiresAt <= now) {
      client.actor = undefined; client.notifications = undefined; client.vault = undefined; client.captain=undefined;
      send(client, { type: "authentication_required" });
    }
    const subscribers = [...clients].filter(c => c.cursor !== undefined);
    if (subscribers.length) {
      try {
        const snapshot = await market().snapshot();
        const active = subscribers.filter(c => c.cursor !== undefined && c.pending === 0);
        // Private delivery below must continue even while a public subscription changes.
        for (const client of active) if (compareCursor(client.cursor!, snapshot.firstCursor) < 0 || compareCursor(client.cursor!, snapshot.cursor) > 0) await resync(client);
        const after = active.filter(c => c.cursor !== undefined).reduce((a, c) => compareCursor(c.cursor!, a) < 0 ? c.cursor! : a, snapshot.cursor);
        for (const [cursor, fields] of await market().read(after)) {
          const event = JSON.parse(fields[fields.indexOf("data") + 1]!) as MarketEvent;
          for (const client of active) if (client.cursor !== undefined && client.pending === 0 && compareCursor(cursor, client.cursor) > 0) {
            if (event.type === "price_update" || event.type === "market_status") {
              if (client.instruments?.includes(event.price.instrumentId)) send(client, { ...event, channel: "market.prices", cursor, price: currentPrice(event.price) });
              else send(client, { type: "cursor", channel: "market.prices", cursor });
              client.cursor = cursor;
            } else await resync(client);
          }
        }
        for (const client of active) {
          const freshness = JSON.stringify(selected(client, snapshot.prices).map(p => [p.instrumentId, p.status]));
          if (client.cursor === snapshot.cursor && client.freshness !== freshness) {
            send(client, { type: "market_status", channel: "market.prices", cursor: snapshot.cursor, prices: selected(client, snapshot.prices) });
            client.freshness = freshness;
          }
        }
      } catch { for (const client of subscribers) send(client, { type: "stream_unavailable", channel: "market.prices" }); }
    }
    const privateClients=[...clients].filter(c=>c.vault && c.actor && c.expiresAt>now && c.pending===0);
    if(privateClients.length) {
      // One scan for the distinct subscribed vaults. Recheck permissions on every delivery scan.
      try {
        const rows=(await db().query<{id:string;captain_id:string;revision:string;event_id:string|null;members:string[]}>(`SELECT f.id,f.captain_id,f.event_sequence::text AS revision,
          e.id AS event_id,ARRAY(SELECT s.user_id::text FROM fund_shares s WHERE s.fund_id=f.id AND s.shares>0) AS members
          FROM funds f LEFT JOIN fund_events e ON e.fund_id=f.id AND e.sequence=f.event_sequence WHERE f.id=ANY($1::uuid[])`,[[...new Set(privateClients.map(c=>c.vault!.id))]])).rows;
        const byId=new Map(rows.map(r=>[r.id,r]));
        for(const client of privateClients) {
          if (!client.actor || client.expiresAt <= Date.now()) { client.vault=undefined; continue; }
          const subscription=client.vault!,row=byId.get(subscription.id);
          if(!row || (row.captain_id!==client.actor && !row.members.includes(client.actor!))){client.vault=undefined;send(client,{type:'error',channel:'vault.context',code:'vault_forbidden'});continue;}
          if(row.revision===subscription.revision)continue;
          send(client,{type:'vault.updated',channel:'vault.context',eventId:row.event_id,vaultId:row.id,accountingRevision:row.revision,cursor:row.revision});
          subscription.revision=row.revision;
        }
      } catch { for(const client of privateClients)send(client,{type:'stream_unavailable',channel:'vault.context'}); }
    }
    const captainClients=[...clients].filter(c=>c.captain&&c.actor&&c.expiresAt>Date.now()&&c.pending===0);
    if(captainClients.length){
      try{
        const rows=(await db().query("SELECT u.id,u.role,COALESCE(s.revision,0)::text AS revision,s.event_id FROM users u LEFT JOIN captain_change_state s ON s.captain_id=u.id WHERE u.id=ANY($1::uuid[])",[[...new Set(captainClients.map(c=>c.actor!))]])).rows;
        const byId=new Map(rows.map(r=>[r.id,r]));
        for(const client of captainClients){
          if(!client.actor||client.expiresAt<=Date.now()){client.captain=undefined;continue;}
          const row=byId.get(client.actor);
          if(!row||row.role!=='captain'){client.captain=undefined;send(client,{type:'error',channel:'captain.dashboard',code:'captain_forbidden'});continue;}
          if(row.revision===client.captain!.revision)continue;
          send(client,{type:'captain.updated',channel:'captain.dashboard',revision:row.revision,cursor:row.revision,eventId:row.event_id});
          client.captain!.revision=row.revision;
        }
      }catch{for(const client of captainClients)send(client,{type:'stream_unavailable',channel:'captain.dashboard'});}
    }
    const actors = new Set([...clients].filter(c => c.actor && c.notifications !== undefined).map(c => c.actor!));
    for (const actor of actors) {
      const group = [...clients].filter(c => c.actor === actor && c.notifications !== undefined);
      const after = group.reduce((a, c) => BigInt(c.notifications!) < BigInt(a) ? c.notifications! : a, group[0]!.notifications!);
      const rows = (await db().query<{ id: string; fund_id: string; type: string; payload: unknown; created_at: Date; read_at: Date | null }>(
        "SELECT id::text,fund_id,type,payload,created_at,read_at FROM notifications WHERE user_id=$1 AND id>$2 ORDER BY notifications.id LIMIT 100", [actor, after])).rows;
      for (const row of rows) for (const client of group) if (client.actor === actor && client.expiresAt > Date.now() && client.notifications !== undefined && BigInt(row.id) > BigInt(client.notifications)) {
        send(client, { type: "notification", channel: "account.notifications", cursor: row.id, notification: {
          id: row.id, fundId: row.fund_id, type: row.type, payload: row.payload, createdAt: row.created_at.toISOString(), readAt: row.read_at?.toISOString() ?? null } });
        client.notifications = row.id;
      }
    }
  }
  const timer = setInterval(() => {
    if (stopped || busy || !clients.size) return;
    busy = tick().catch(() => undefined).finally(() => { busy = undefined; });
  }, 500);
  timer.unref();
  app.addHook("onClose", async () => { stopped = true; clearInterval(timer); await busy; bus?.close(); });
}
