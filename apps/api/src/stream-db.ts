import { inTransaction,type DbPool,type DbRow } from '@socially/db';
export function streamQuery<T extends DbRow = DbRow>(pool:DbPool,sql:string,args:unknown[]=[]){
  return inTransaction(pool,client=>client.query<T>(sql,args));
}
