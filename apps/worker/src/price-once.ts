import { createPool } from "@socially/db";
import { ingestSolPrice } from "./prices.js";

const pool = createPool();
try {
  await ingestSolPrice(pool, process.env.PYTH_API_KEY ?? "");
  console.info("SOL/USD price observation stored");
} finally {
  await pool.end();
}
