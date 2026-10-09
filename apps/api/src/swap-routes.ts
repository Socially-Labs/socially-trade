import type { FastifyInstance } from 'fastify';
import type { DbPool } from '@socially/db';
import { PublicKey } from '@solana/web3.js';
import { requireActor } from './auth.js';
import { ApiFault } from './errors.js';
import { ownedSwap, prepareWalletSwap, quoteSwap, submitWalletSwap, swapRateLimit, swapView, type SwapLayer, type SwapRow } from './swap-flows.js';
import type { SwapToken } from './swap-types.js';
const uuid={type:'string',format:'uuid'} as const;
const params={type:'object',required:['id'],additionalProperties:false,properties:{id:uuid}} as const;
export function registerSwapRoutes(app:FastifyInstance,db:()=>DbPool,layer:SwapLayer|null) {
  const configured=()=>{if(!layer)throw new ApiFault(503,'swaps_unavailable','Wallet swaps are not configured');return layer;};
  app.post<{Body:{wallet:string;input:SwapToken;amountRaw:string}}>('/v1/me/swaps/quotes',{
    schema:{body:{type:'object',required:['wallet','input','amountRaw'],additionalProperties:false,properties:{wallet:{type:'string',minLength:32,maxLength:44},input:{type:'string',enum:['SOL','USDC']},amountRaw:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}}}},
  },async(req,reply)=>{
    const actor=await requireActor(req,db()),service=configured();
    try{if(new PublicKey(req.body.wallet).toBase58()!==req.body.wallet)throw new Error();}catch{throw new ApiFault(400,'invalid_wallet','Invalid Solana wallet');}
    if(BigInt(req.body.amountRaw)>18446744073709551615n)throw new ApiFault(400,'invalid_amount','Amount exceeds the token limit');
    reply.code(201).header('cache-control','no-store');
    return {quote:await quoteSwap(db(),service,actor,req.body)};
  });
  app.post<{Body:{quoteId:string;clientRequestId:string}}>('/v1/me/swaps',{
    schema:{body:{type:'object',required:['quoteId','clientRequestId'],additionalProperties:false,properties:{quoteId:uuid,clientRequestId:uuid}}},
  },async(req,reply)=>{
    const actor=await requireActor(req,db());reply.code(201).header('cache-control','no-store');
    return {swap:await prepareWalletSwap(db(),configured(),actor,req.body)};
  });
  app.post<{Params:{id:string};Body:{signedTransaction:string}}>('/v1/me/swaps/:id/submit',{
    schema:{params,body:{type:'object',required:['signedTransaction'],additionalProperties:false,properties:{signedTransaction:{type:'string',maxLength:1644,minLength:1}}}},
  },async(req,reply)=>{
    const actor=await requireActor(req,db());
    const swap=await submitWalletSwap(db(),configured(),actor,req.params.id,req.body.signedTransaction);
    reply.code(swap.status==='SUBMITTED'?202:200).header('cache-control','no-store');return {swap};
  });
  app.get<{Params:{id:string}}>('/v1/me/swaps/:id',{schema:{params}},async(req,reply)=>{
    const actor=await requireActor(req,db());configured();await swapRateLimit(db(),actor.id,'read',2400);
    reply.header('cache-control','no-store');return {swap:swapView(await ownedSwap(db(),actor.id,req.params.id))};
  });
  app.get<{Querystring:{status?:SwapRow['status'];after?:string;limit?:string}}>('/v1/me/swaps',{
    schema:{querystring:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['PREPARED','SUBMITTED','CONFIRMED','FAILED','EXPIRED']},after:uuid,limit:{type:'string',pattern:'^([1-9]|[1-4][0-9]|50)$'}}}},
  },async(req,reply)=>{
    const actor=await requireActor(req,db());configured();await swapRateLimit(db(),actor.id,'read',2400);
    const limit=Number(req.query.limit??20);
    const rows=await db().query<SwapRow>(`SELECT * FROM wallet_swaps WHERE user_id=$1 AND ($2::text IS NULL OR status=$2)
      AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM wallet_swaps WHERE id=$3 AND user_id=$1))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[actor.id,req.query.status??null,req.query.after??null,limit+1]);
    reply.header('cache-control','no-store');return {swaps:rows.rows.slice(0,limit).map(swapView),nextCursor:rows.rows.length>limit?rows.rows[limit-1]!.id:null};
  });
}
