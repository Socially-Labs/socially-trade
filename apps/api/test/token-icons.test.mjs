import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { TokenIcons } from '../dist/token-icons.js';
import { publicImageAddress, imageUrl, iconCandidates, normalizeIcon } from '../dist/token-icon-download.js';

const mint = 'So11111111111111111111111111111111111111112';
const cid = 'bafkreibyb3hcn7gglvdqpmklfev3fut3eqv3kje54l3to3xzxxbgpt5wjm';
const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#f00' } }).png().toBuffer();
function cache() {
  const values = new Map(), locks = new Map();
  return { values, async read(key) { return values.get(key) ?? null; }, async write(key, value) { values.set(key, value); },
    async claim(key, owner) { if (locks.has(key)) return false; locks.set(key, owner); return true; }, async release(key, owner) { if (locks.get(key) === owner) locks.delete(key); }, close() {} };
}

test('rejects private/network-local image destinations and unsafe URL schemes', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','172.16.0.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2002:7f00:1::1','2001:db8::1']) assert.equal(publicImageAddress(ip), false, ip);
  assert.equal(publicImageAddress('1.1.1.1'), true);
  assert.equal(publicImageAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://example.com/a.png','file:///etc/passwd','https://localhost/a','https://127.0.0.1/a','https://[::1]/a','https://user:pass@example.com/a','https://example.com:8443/a']) assert.throws(() => imageUrl(url), url);
});

test('IPFS fallback preserves the CID and path and also handles subdomain gateways', () => {
  const expected = [`https://gateway.example/ipfs/${cid}/image.png?x=1`, `https://ipfs.io/ipfs/${cid}/image.png?x=1`];
  assert.deepEqual(iconCandidates(expected[1], ['https://gateway.example/ipfs/']), expected);
  assert.equal(iconCandidates(`https://${cid}.ipfs.w3s.link/image.png`, ['https://gateway.example/ipfs/'])[0], `https://gateway.example/ipfs/${cid}/image.png`);
  assert.deepEqual(iconCandidates('https://example.com/logo.png', []), ['https://example.com/logo.png']);
});

test('normalizes raster and SVG to bounded WebP; rejects HTML and external SVG resources', async () => {
  for (const bytes of [png, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="red"/></svg>')]) {
    const result = await normalizeIcon(bytes), metadata = await sharp(result).metadata();
    assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 128); assert.ok(result.length <= 65536);
  }
  await assert.rejects(normalizeIcon(Buffer.from('<html>Error</html>')));
  await assert.rejects(normalizeIcon(Buffer.from('<svg width="16" height="16"><image href="file:///etc/passwd"/></svg>')));
  await assert.rejects(normalizeIcon(Buffer.alloc(2 * 1024 * 1024 + 1)));
});

test('coalesces same-mint requests, falls back from a failed gateway, and shares processed cache across instances', async () => {
  const store = cache(); let lookups = 0, downloads = 0;
  const source = async () => { lookups++; return `https://ipfs.io/ipfs/${cid}`; };
  const download = async url => { downloads++; await new Promise(resolve => setTimeout(resolve, 5)); if (url.includes('bad.example')) throw new Error('gateway unavailable'); return png; };
  const service = new TokenIcons(source, store, ['https://bad.example/ipfs/', 'https://good.example/ipfs/'], download);
  const results = await Promise.all(Array.from({length: 10}, () => service.get(mint)));
  assert.ok(results.every(bytes => bytes.equals(results[0]))); assert.equal(lookups, 1); assert.equal(downloads, 2);
  const second = new TokenIcons(source, store, [], download);
  assert.ok((await second.get(mint)).equals(results[0])); assert.equal(lookups, 1); assert.equal(downloads, 2);
});

test('negative caching prevents repeated downloads; missing logos never download', async () => {
  let calls = 0; const store = cache();
  const service = new TokenIcons(async () => 'https://example.com/broken', store, [], async () => { calls++; throw new Error('HTTP 429'); });
  for (let i = 0; i < 3; i++) await assert.rejects(service.get(mint), e => e.statusCode === 503);
  assert.equal(calls, 1); assert.equal(store.values.get(mint), 'unavailable');
  const missing = new TokenIcons(async () => null, cache(), [], async () => { throw new Error('must not download'); });
  await assert.rejects(missing.get(mint), e => e.statusCode === 404);
  await assert.rejects(missing.get('../../private'), e => e.statusCode === 400);
});

test('limits concurrent downloads to four and lets cached icons bypass the download queue', async () => {
  let active = 0, maximum = 0; const store = cache();
  const service = new TokenIcons(async () => 'https://example.com/icon', store, [], async () => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return png;
  });
  await Promise.all('123456789'.split('').map(c => service.get(c.repeat(32))));
  assert.equal(maximum, 4); assert.equal(active, 0);
});
