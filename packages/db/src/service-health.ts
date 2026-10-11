import { randomUUID } from 'node:crypto';
import type { DbPool } from './index.js';
import { envInteger } from '@socially/domain';
export function serviceHeartbeat(pool:DbPool,service:'worker'|'ingestor'){
 const instance=randomUUID();let next=0;
 return async()=>{if(Date.now()<next)return;
  await pool.query(`INSERT INTO paper_service_heartbeats(service,instance_id,completed_at) VALUES($1,$2,clock_timestamp())
    ON CONFLICT(service) DO UPDATE SET instance_id=EXCLUDED.instance_id,completed_at=EXCLUDED.completed_at`,[service,instance]);
  next=Date.now()+envInteger('PAPER_HEARTBEAT_INTERVAL_MS',10000);
 };
}
