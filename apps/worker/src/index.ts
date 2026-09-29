import { createPool } from "@socially/db";
import { ingestSolPrice } from "./prices.js";

const apiKey = process.env.PYTH_API_KEY;
if (!apiKey) throw new Error("PYTH_API_KEY is required for the market-data worker");
const pool = createPool();
let running = true;
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

try {
  while (running) {
    try {
      await ingestSolPrice(pool, apiKey);
    } catch (error) {
      console.error("SOL/USD ingestion failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
} finally {
  await pool.end();
}
