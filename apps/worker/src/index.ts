import { createPool } from "@socially/db";
import { ingestSolPrice } from "./prices.js";
import { markActiveFunds, processPendingOrders } from "./orders.js";
import { deliverOutbox } from "./notifications.js";

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
    try {
      if (apiKey && Date.now() >= nextPriceFetch) {
        await ingestSolPrice(pool, apiKey);
        nextPriceFetch = Date.now() + 15_000;
      }
      await markActiveFunds(pool);
      await processPendingOrders(pool);
      await deliverOutbox(pool);
    } catch (error) {
      console.error("Paper worker cycle failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await pool.end();
}
