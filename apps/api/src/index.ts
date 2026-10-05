import { createPool } from "@socially/db";
import { createApp } from "./app.js";
import { createDevnetChain, loadTokenConfig } from "./token-chain.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const pool = process.env.DATABASE_URL ? createPool() : null;
const tokenConfig = await loadTokenConfig();
// Refuses to start against a mainnet RPC, a non-devnet cluster or a mint we do not control.
const token = tokenConfig
  ? { chain: await createDevnetChain(tokenConfig), signupGrantRaw: tokenConfig.signupGrantRaw }
  : null;
const app = createApp(pool, { token });
await app.listen({
  port,
  host: process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
}
