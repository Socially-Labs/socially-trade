import { createPool } from "@socially/db";
import { captureConsole, LogCollector } from "@socially/logging";
import { createApp } from "./app.js";
import { createDevnetChain, loadTokenConfig } from "./token-chain.js";
import { tokenLimits } from "./token-flows.js";

import { startQrDepositWorker } from "./qr-deposits.js";

const logs = new LogCollector("api");
captureConsole(logs);
console.info("API starting");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const pool = process.env.DATABASE_URL ? createPool() : null;
const tokenConfig = await loadTokenConfig();
// Refuses to start against a mainnet RPC, a non-devnet cluster or a mint we do not control.
if (tokenConfig) tokenLimits(); // Invalid limits stop the server here, not at the first request.
const token = tokenConfig
  ? {
    chain: await createDevnetChain(tokenConfig), signupGrantRaw: tokenConfig.signupGrantRaw,
    allowUnverifiedWallet: tokenConfig.allowUnverifiedWallet,
  }
  : null;
const app = createApp(pool, { token, logs });
const stopQrWorker = pool && token ? startQrDepositWorker(pool, token.chain, error => app.log.error(error)) : null;
app.addHook("preClose", async () => { await stopQrWorker?.(); });
await app.listen({
  port,
  host: process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
}
