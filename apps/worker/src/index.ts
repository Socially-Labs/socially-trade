import { createPool } from "@socially/db";
import { captureConsole, LogCollector } from "@socially/logging";
import { runWorkerCycle } from "./cycle.js";

const logs = new LogCollector("worker");
captureConsole(logs);
console.info("Paper worker starting");
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
    const { failures: _failures, ...counts } = result;
    if (Object.values(counts).some(count => count > 0)) console.info("Paper worker cycle completed", counts);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  console.info("Paper worker stopping");
  await logs.close();
  await pool.end();
}
