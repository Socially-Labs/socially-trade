import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { appendFundEvent,inTransaction,type DbPool } from '@socially/db';
import { requireActor } from './auth.js';
import { ApiFault } from './errors.js';
import { AssetStorage,MAX_IMAGE_BYTES,type AssetKind,type UploadFile } from './asset-storage.js';
interface Upload extends UploadFile { id:string; fund_id:string; user_id:string; kind:AssetKind; status:string; public_url:string|null; expires_at:Date; lease_until:Date|null }
type Storage=Pick<AssetStorage,'sign'|'publish'|'discard'>;
export async function reserveVaultUpload(pool:DbPool,userId:string,fundId:string,input:{ kind:AssetKind; contentType:string; byteSize:number },storage:()=>Storage) {
 const id=randomUUID(),file={ staging_key:`pending/vaults/${fundId}/${id}`,content_type:input.contentType,byte_size:input.byteSize };
 const expiresAt=await inTransaction(pool,async client=>{
  // Owner check precedes storage access; short user lock serializes the per-user budget.
  if (!(await client.query('SELECT 1 FROM funds f JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=$1 AND f.captain_id=$2',[fundId,userId])).rowCount) throw new ApiFault(404,'vault_not_found','Owned vault not found');
  await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[userId]);
  const count=(await client.query<{ count:string }>("SELECT count(*)::text FROM vault_asset_uploads WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 hour'",[userId])).rows[0]!.count;
  if (Number(count)>=20) throw new ApiFault(429,'upload_rate_limited','Maximum 20 vault image uploads per hour');
  return (await client.query<{ expires_at:Date }>(`INSERT INTO vault_asset_uploads(id,fund_id,user_id,kind,content_type,byte_size,staging_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING expires_at`,[id,fundId,userId,input.kind,input.contentType,input.byteSize,file.staging_key])).rows[0]!.expires_at;
 });
 const url=await storage().sign(file);
 return { uploadId:id,kind:input.kind,method:'PUT',uploadUrl:url,headers:{ 'Content-Type':input.contentType },byteSize:input.byteSize,
  uploadUrlExpiresAt:new Date(Date.now()+300_000).toISOString(),completeBefore:expiresAt.toISOString() };
}
export async function completeVaultUpload(pool:DbPool,userId:string,fundId:string,uploadId:string,storage:()=>Storage) {
 const lease=randomUUID();
 const row=await inTransaction(pool,async client=>{
  const row=(await client.query<Upload>('SELECT u.* FROM vault_asset_uploads u JOIN funds f ON f.id=u.fund_id WHERE u.id=$1 AND u.fund_id=$2 AND u.user_id=$3 AND f.captain_id=$3 FOR UPDATE OF u',[uploadId,fundId,userId])).rows[0];
  if (!row) throw new ApiFault(404,'asset_upload_not_found','Upload not found');
  if (row.status==='COMPLETED') return row;
  const now=(await client.query<{ now:Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  if (row.expires_at<=now) throw new ApiFault(410,'asset_upload_expired','Choose the image again');
  if (row.status==='PROCESSING' && row.lease_until && row.lease_until>now) throw new ApiFault(409,'image_processing','Image completion is in progress; refresh shortly');
  await client.query("UPDATE vault_asset_uploads SET status='PROCESSING',lease_id=$2,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",[uploadId,lease]);
  return row;
 });
 if (row.status==='COMPLETED') return { id:row.id,kind:row.kind,url:row.public_url! };
 try {
  // S3 reads, byte validation, Sharp and publication never hold financial SQL locks.
  const url=await storage().publish(row,row.kind,fundId,`${row.id}-${lease}`,'vaults');
  await inTransaction(pool,async client=>{
   const updated=await client.query("UPDATE vault_asset_uploads SET status='COMPLETED',public_url=$3,completed_at=clock_timestamp(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 RETURNING id",[row.id,lease,url]);
   if (!updated.rowCount) throw new ApiFault(409,'upload_lease_changed','Retry image completion');
   await client.query(`INSERT INTO vault_media(fund_id,kind,upload_id,public_url) VALUES($1,$2,$3,$4)
    ON CONFLICT(fund_id,kind) DO UPDATE SET upload_id=EXCLUDED.upload_id,public_url=EXCLUDED.public_url`,[fundId,row.kind,row.id,url]);
   await appendFundEvent(client,fundId,'vault_art_updated',{});
  });
  try { await storage().discard(row.staging_key); } catch { /* Private staging bucket lifecycle handles cleanup. */ }
  return { id:row.id,kind:row.kind,url };
 } catch (error) {
  await pool.query("UPDATE vault_asset_uploads SET status='PENDING',lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",[row.id,lease]);
  throw error;
 }
}
export function registerVaultUploadRoutes(app:FastifyInstance,db:()=>DbPool) {
 let configured:AssetStorage|undefined; const storage=()=>configured??=new AssetStorage();
 app.addHook('onClose',async()=>configured?.close());
 const uuid={ type:'string',format:'uuid' };
 const params={ type:'object',required:['id'],additionalProperties:false,properties:{ id:uuid } };
 app.post<{ Params:{ id:string }; Body:{ kind:AssetKind; contentType:string; byteSize:number } }>('/v1/vaults/:id/assets/uploads',{ schema:{ params,body:{ type:'object',required:['kind','contentType','byteSize'],additionalProperties:false,properties:{ kind:{ type:'string',enum:['avatar','banner'] },contentType:{ type:'string',enum:['image/jpeg','image/png','image/webp'] },byteSize:{ type:'integer',minimum:1,maximum:MAX_IMAGE_BYTES } } } } },async(req,reply)=>{
  const actor=await requireActor(req,db()); reply.header('cache-control','no-store').code(201);
  return reserveVaultUpload(db(),actor.id,req.params.id,req.body,storage);
 });
 app.post<{ Params:{ id:string; uploadId:string } }>('/v1/vaults/:id/assets/uploads/:uploadId/complete',{ schema:{ params:{ ...params,required:['id','uploadId'],properties:{ id:uuid,uploadId:uuid } } } },async(req,reply)=>{
  const actor=await requireActor(req,db()); reply.header('cache-control','no-store');
  return { asset:await completeVaultUpload(db(),actor.id,req.params.id,req.params.uploadId,storage) };
 });
}
