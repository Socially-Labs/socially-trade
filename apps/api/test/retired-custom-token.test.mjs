import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { vaultConfig } from '../dist/vaults.js';

test('stale custom mint configuration cannot enable treasury routes or disable paper vaults', async () => {
  const names = ['USDG_MINT', 'VAULT_PAPER_ENABLED', 'VAULT_TERMS_APPROVAL', 'PAPER_WALLET_SNAPSHOT_ENABLED'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.USDG_MINT = 'retired-custom-mint';
  process.env.VAULT_PAPER_ENABLED = 'true';
  process.env.VAULT_TERMS_APPROVAL = 'locked-v1-retain-residue';
  process.env.PAPER_WALLET_SNAPSHOT_ENABLED = 'false';
  const app = createApp(null);
  app.log.level = 'silent';
  try {
    assert.equal(vaultConfig().enabled, true);
    for (const [method, url] of [
      ['POST', '/v0/me/qr-deposits'], ['GET', '/v0/me/qr-deposits/old-payment'],
      ['GET', '/v0/me/token-balance'], ['POST', '/v0/me/deposits/prepare'],
      ['POST', '/v0/me/deposits'], ['GET', '/v0/me/deposits/old-signature'],
      ['POST', '/v0/me/withdrawals'], ['GET', '/v0/me/withdrawals/old-withdrawal'],
    ]) {
      assert.equal((await app.inject({ method, url })).statusCode, 404, `${method} ${url}`);
    }
    // The authenticated paper summary still exists; no database is configured in this fixture.
    assert.equal((await app.inject({ method: 'GET', url: '/v0/me/wallet' })).statusCode, 503);
  } finally {
    await app.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
