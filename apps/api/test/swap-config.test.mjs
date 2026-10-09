import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSwapConfig } from '../dist/swap-config.js';

test('RPC query authentication is supported while unsafe URLs and venue queries remain rejected', () => {
  const saved = { ...process.env };
  try {
    process.env.SWAP_ENABLED = 'true';
    process.env.SOLANA_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=test-only';
    delete process.env.SWAP_VENUE_URL;
    assert.equal(new URL(loadSwapConfig().rpcUrl).searchParams.get('api-key'), 'test-only');
    process.env.SOLANA_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=test%2Bkey/';
    assert.equal(loadSwapConfig().rpcUrl, process.env.SOLANA_RPC_URL);
    for (const rpc of ['http://rpc.example', 'https://user:secret@rpc.example', 'https://rpc.example/#fragment']) {
      process.env.SOLANA_RPC_URL = rpc;
      assert.throws(loadSwapConfig, /Invalid SOLANA_RPC_URL/);
    }
    process.env.SOLANA_RPC_URL = 'https://rpc.example/?api-key=test-only';
    process.env.SWAP_VENUE_URL = 'https://venue.example/?api-key=test-only';
    assert.throws(loadSwapConfig, /Invalid SWAP_VENUE_URL/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
