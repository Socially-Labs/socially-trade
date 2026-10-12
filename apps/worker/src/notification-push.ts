import type { DbPool } from '@socially/db';

type Delivery={notification_id:string;device_id:string;user_id:string;token:string;ticket_id:string|null;attempts:number};
type ExpoResult={status?:string;id?:string;details?:{error?:string}};
async function expo(path:string,body:unknown):Promise<unknown> {
 const response=await fetch(`https://exp.host/--/api/v2/push/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.EXPO_ACCESS_TOKEN?{Authorization:`Bearer ${process.env.EXPO_ACCESS_TOKEN}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error(`expo_http_${response.status}`);
 return response.json();
}
/** Leased durable jobs, at-least-once delivery. Notification IDs deduplicate UI. */
export async function deliverNotificationPush(pool:DbPool):Promise<number> {
 if(process.env.NOTIFICATION_PUSH_ENABLED!=='true')return 0;
 // Logout, account switch and expired installations invalidate queued work.
 await pool.query(`UPDATE notification_push_deliveries p SET failed_at=now(),last_error='device_inactive'
 WHERE delivered_at IS NULL AND failed_at IS NULL AND NOT EXISTS(SELECT 1 FROM notification_devices d
 WHERE d.id=p.device_id AND d.user_id=p.user_id AND d.token=p.token AND d.revoked_at IS NULL AND d.updated_at>now()-interval '30 days')`);
 const rows=(await pool.query<Delivery>(`WITH claimed AS (
 SELECT notification_id,device_id FROM notification_push_deliveries
 WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED)
 UPDATE notification_push_deliveries p SET attempts=attempts+1,next_attempt_at=now()+interval '2 minutes'
 FROM claimed c WHERE p.notification_id=c.notification_id AND p.device_id=c.device_id
 RETURNING p.notification_id::text,p.device_id,p.user_id,p.token,p.ticket_id,p.attempts`)).rows;
 let delivered=0;
 await Promise.all(rows.map(async row=>{
  const keys=[row.notification_id,row.device_id];
  try{
   const result=await expo(row.ticket_id?'getReceipts':'send',row.ticket_id?{ids:[row.ticket_id]}:[{
    to:row.token,title:'Socially',body:'You have a new account update.',sound:'default',channelId:'account-updates',
    // Account ID prevents a late OS notification opening the previous account.
    data:{notificationId:row.notification_id,accountId:row.user_id},ttl:3600,
   }]) as {data?:ExpoResult[]|Record<string,ExpoResult>};
   const status=row.ticket_id?(result.data as Record<string,ExpoResult>|undefined)?.[row.ticket_id]:(result.data as ExpoResult[]|undefined)?.[0];
   if(status?.status==='ok'){
    if(row.ticket_id){await pool.query('UPDATE notification_push_deliveries SET delivered_at=now(),last_error=NULL WHERE notification_id=$1 AND device_id=$2',keys);delivered++;}
    else if(typeof status.id==='string')await pool.query(`UPDATE notification_push_deliveries SET ticket_id=$3,receipt_due_at=now()+interval '15 minutes',next_attempt_at=now()+interval '15 minutes',attempts=0,last_error=NULL WHERE notification_id=$1 AND device_id=$2`,[...keys,status.id]);
    else throw new Error('invalid_ticket');
   }else if(status?.details?.error==='DeviceNotRegistered'){
    await pool.query('UPDATE notification_devices SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND token=$3',[row.device_id,row.user_id,row.token]);
    await pool.query("UPDATE notification_push_deliveries SET failed_at=now(),last_error='DeviceNotRegistered' WHERE notification_id=$1 AND device_id=$2",keys);
   }else if(['MessageTooBig','InvalidCredentials','MismatchSenderId'].includes(status?.details?.error??'')){
    await pool.query('UPDATE notification_push_deliveries SET failed_at=now(),last_error=$3 WHERE notification_id=$1 AND device_id=$2',[...keys,status!.details!.error]);
   }else throw new Error(status?.details?.error??'receipt_pending');
  }catch(error){
   const reason=error instanceof Error?error.message:'push_unavailable';
   await pool.query(`UPDATE notification_push_deliveries SET last_error=$3,
     failed_at=CASE WHEN attempts>=12 THEN now() ELSE NULL END,
     next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))+random()*15)
     WHERE notification_id=$1 AND device_id=$2`,[...keys,reason.slice(0,120)]);
  }
 }));
 return delivered;
}
