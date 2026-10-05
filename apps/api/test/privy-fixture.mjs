import { generateKeyPairSync, sign } from 'node:crypto';

// Test-local signing keys. The API uses its real Privy verifier; no auth bypass.
export function configurePrivyFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  process.env.PRIVY_APP_ID = 'local-paper-test';
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid: 'fixture-key' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    if (String(input) === 'https://api.privy.io/v1/apps/local-paper-test/jwks.json') return Response.json({ keys: [jwk] });
    // Loopback requests reach the API under test (for example the SSE test).
    const { hostname } = new URL(typeof input === 'string' ? input : input.url ?? input);
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname)) return realFetch(input, options);
    throw new Error('Simulation attempted an unexpected external request');
  };
  return subject => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'fixture-key' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: `did:privy:${subject}`, iss: 'privy.io',
      aud: 'local-paper-test', iat: now, exp: now + 3600 })).toString('base64url');
    const data = `${header}.${body}`;
    const signature = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${data}.${signature.toString('base64url')}`;
  };
}
