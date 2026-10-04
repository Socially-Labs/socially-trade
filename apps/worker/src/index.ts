import { createPool } from "@socially/db";
import { runWorkerCycle } from "./cycle.js";

const pool = createPool();
let running = true;
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

try {
  while (running) {
    const result = await runWorkerCycle(pool);
    for (const failure of result.failures) {
      console.error("Paper worker job failed", failure);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await pool.end();
}
