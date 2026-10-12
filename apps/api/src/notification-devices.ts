import type { FastifyInstance } from 'fastify';
import { inTransaction, type DbPool } from '@socially/db';
import { requireActor } from './auth.js';
import { ApiFault } from './errors.js';

export function registerNotificationDevices(app: FastifyInstance, db: () => DbPool) {
  app.put<{Body:{installationId?:unknown;token?:unknown;platform?:unknown}}>('/v0/me/notification-device',async(request,reply)=>{
    reply.header('cache-control','no-store');
    const actor=await requireActor(request,db()), body=request.body;
    if(!body || typeof body.installationId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.installationId) ||
      typeof body.token!=='string' || !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$/.test(body.token) || !['android','ios'].includes(String(body.platform)))
      throw new ApiFault(400,'invalid_device','A valid installation, push token and platform are required');
    await inTransaction(db(),async client=>{
      // This token can belong to only one signed-in account. Revoke prior bindings
      // before assigning a different installation, including pending old deliveries.
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor.id]);
      const count=await client.query(`SELECT id FROM notification_devices WHERE user_id=$1 AND revoked_at IS NULL AND updated_at>now()-interval '30 days' AND id<>$2`,[actor.id,body.installationId]);
      if(count.rows.length>=10)throw new ApiFault(409,'device_limit','Remove an existing notification device first');
      await client.query(`UPDATE notification_devices SET revoked_at=now(),token='revoked:'||id::text WHERE token=$1 AND id<>$2`,[body.token,body.installationId]);
      await client.query(`INSERT INTO notification_devices(id,user_id,token,platform) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,token=EXCLUDED.token,platform=EXCLUDED.platform,updated_at=now(),revoked_at=NULL`,[body.installationId,actor.id,body.token,body.platform]);
    });
    return {registered:true};
  });
  app.delete<{Body:{installationId?:unknown}}>('/v0/me/notification-device',async request=>{
    const actor=await requireActor(request,db());
    if(typeof request.body?.installationId!=='string' || !/^[a-f0-9-]{36}$/i.test(request.body.installationId))throw new ApiFault(400,'invalid_device','Installation ID required');
    await db().query('UPDATE notification_devices SET revoked_at=now() WHERE id=$1 AND user_id=$2',[request.body.installationId,actor.id]);
    return {registered:false};
  });
}
