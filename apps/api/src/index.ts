import { loadSwapConfig } from "./swap-config.js";
import { SolanaLiveVaultChain } from './live-vault-chain.js';
import { RaydiumSwapChain } from "./swap-chain.js";
import { createPool } from "@socially/db";
import { captureConsole, LogCollector } from "@socially/logging";
import { createApp } from "./app.js";
import { createDevnetChain, loadTokenConfig } from "./token-chain.js";
import { tokenLimits } from "./token-flows.js";

import { startQrDepositWorker } from "./qr-deposits.js";
import { installShutdown } from './shutdown.js';

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
const swapConfig = loadSwapConfig();
const swapChain = swapConfig ? new RaydiumSwapChain(swapConfig) : null;
if (swapChain) await swapChain.assertDevnet();
const liveVaults = new SolanaLiveVaultChain(process.env.SOLANA_RPC_URL ?? process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com',swapChain,process.env.LIVE_VAULTS_ENABLED !== 'false');
const app = createApp(pool, { token, logs, liveVaults, swaps: swapChain && swapConfig ? { chain: swapChain, config: swapConfig } : null });
const stopQrWorker = pool && token ? startQrDepositWorker(pool, token.chain, error => app.log.error(error)) : null;
app.addHook("preClose", async () => { await stopQrWorker?.(); });
await app.listen({
  port,
  host: process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
});

installShutdown(() => app.close());
