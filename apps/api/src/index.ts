import { loadSwapConfig } from "./swap-config.js";
import { SolanaLiveVaultChain } from './live-vault-chain.js';
import { RaydiumSwapChain } from "./swap-chain.js";
import { createPool } from "@socially/db";
import { captureConsole, LogCollector } from "@socially/logging";
import { createApp } from "./app.js";

import { installShutdown } from './shutdown.js';

const logs = new LogCollector("api");
captureConsole(logs);
console.info("API starting");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const pool = process.env.DATABASE_URL ? createPool() : null;
const swapConfig = loadSwapConfig();
const swapChain = swapConfig ? new RaydiumSwapChain(swapConfig) : null;
if (swapChain) await swapChain.assertDevnet();
const liveVaults = new SolanaLiveVaultChain(process.env.SOLANA_RPC_URL ?? process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com',swapChain,process.env.LIVE_VAULTS_ENABLED !== 'false');
const app = createApp(pool, { logs, liveVaults, swaps: swapChain && swapConfig ? { chain: swapChain, config: swapConfig } : null });
await app.listen({
  port,
  host: process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
});

installShutdown(() => app.close());
