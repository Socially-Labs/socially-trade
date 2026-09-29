import { randomUUID } from "node:crypto";
import { createPool } from "@socially/db";

if (process.env.NODE_ENV === "production" || process.env.DEV_PRICE_SEED_ENABLED !== "true") {
  throw new Error("Manual price seeding is development-only and requires DEV_PRICE_SEED_ENABLED=true");
}
const price = process.argv.at(-1);
if (!price || !/^(0|[1-9]\d*)(\.\d+)?$/.test(price) || Number(price) <= 0) {
  throw new Error("Pass a positive SOL/USD decimal price, for example: price:seed -- 150.00");
}
const pool = createPool();
try {
  await pool.query(
    `INSERT INTO price_observations
     (id, instrument_id, source, source_ref, price_usdc, source_at)
     VALUES ($1, 'SOL', 'DEV_SEED', $2, $3, now())`,
    [randomUUID(), `dev:${randomUUID()}`, price],
  );
  console.info(`Stored development SOL/USD price ${price}`);
} finally {
  await pool.end();
}
