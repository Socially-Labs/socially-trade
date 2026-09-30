import { createPool } from "@socially/db";
import { deliverOutbox } from "./notifications.js";

const pool = createPool();
try {
  console.info(`Delivered ${await deliverOutbox(pool)} outbox records`);
} finally {
  await pool.end();
}
