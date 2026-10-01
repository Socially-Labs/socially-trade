import { createPool } from "@socially/db";
import { ingestSolPrice } from "./prices.js";
import { runWorkerCycle } from "./cycle.js";

const apiKey = process.env.PYTH_API_KEY;
const devPrices = process.env.NODE_ENV !== "production" && process.env.DEV_PRICE_SEED_ENABLED === "true";
if (!apiKey && !devPrices) throw new Error("PYTH_API_KEY is required unless local price seeding is enabled");
const pool = createPool();
let running = true;
let nextPriceFetch = 0;
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

try {
  while (running) {
    const fetchPrice = apiKey && Date.now() >= nextPriceFetch;
    if (fetchPrice) nextPriceFetch = Date.now() + 15_000;
    const result = await runWorkerCycle(pool, fetchPrice ? () => ingestSolPrice(pool, apiKey!) : undefined);
    for (const failure of result.failures) {
      console.error("Paper worker job failed", failure);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await pool.end();
}
