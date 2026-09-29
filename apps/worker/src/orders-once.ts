import { createPool } from "@socially/db";
import { markActiveFunds, processPendingOrders } from "./orders.js";

const pool = createPool();
try {
  const marked = await markActiveFunds(pool);
  const processed = await processPendingOrders(pool);
  console.info(`Marked ${marked} funds and processed ${processed} orders`);
} finally {
  await pool.end();
}
