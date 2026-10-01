import { randomUUID } from "node:crypto";
import type { DbClient } from "./index.js";

export async function saveFundNav(client: DbClient, input: {
  fundId: string;
  navUsdc: string;
  sharePriceUsdc: string;
  pricedAt: Date;
  observationId?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO nav_snapshots
     (id,fund_id,nav_usdc,share_price_usdc,status,priced_at,event_sequence,observation_id,performance_fee_factor)
     SELECT $1,id,$3,$4,'CURRENT',$5,event_sequence,$6,performance_fee_factor FROM funds WHERE id=$2`,
    [randomUUID(), input.fundId, input.navUsdc, input.sharePriceUsdc, input.pricedAt, input.observationId ?? null],
  );
  await client.query(
    "UPDATE funds SET peak_share_price=GREATEST(peak_share_price,$2::numeric) WHERE id=$1",
    [input.fundId, input.sharePriceUsdc],
  );
}
