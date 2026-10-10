import { request } from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import sharp from 'sharp';

const MAX_BYTES = 2 * 1024 * 1024;
const specialV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) specialV6.addSubnet(address, prefix, 'ipv6');

/** Download destinations must be public, including every DNS result/redirect. */
export function publicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
  }
  // Global unicast only; excludes loopback, mapped IPv4, link-local and ULA.
  return isIP(address) === 6 && /^[23]/i.test(address) && !specialV6.check(address, 'ipv6');
}

export function imageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || value.length > 2048 ||
    url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw new Error('Invalid image URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicImageAddress(host)) throw new Error('Private image destination');
  return url;
}

/** Preserve the CID/path rather than searching by symbol or changing token identity. */
export function iconCandidates(source: string, gateways: string[]): string[] {
  const url = imageUrl(source);
  const subdomain = url.hostname.match(/^([a-z0-9]+)\.ipfs\./i);
  const match = url.pathname.match(/^\/ipfs\/([a-zA-Z0-9]+)(\/.*)?$/);
  const cid = subdomain?.[1] ?? match?.[1];
  if (!cid || !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(cid)) return [url.href];
  const suffix = subdomain ? url.pathname : match?.[2] ?? '';
  const candidates = gateways.map(base => {
    const gateway = imageUrl(base);
    if (gateway.search || gateway.hash || !gateway.pathname.endsWith('/ipfs/')) throw new Error('Gateway must end in /ipfs/');
    return `${gateway.href}${cid}${suffix}${url.search}`;
  });
  return [...new Set([...candidates, url.href])].slice(0, 3);
}

export async function downloadIcon(value: string, signal: AbortSignal, redirects = 0): Promise<Buffer> {
  const url = imageUrl(value);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal, family: 4,
      headers: { accept: 'image/*', 'user-agent': 'Socially-Token-Images/1.0' },
      // Validate and pin the actual connection address, preventing DNS rebinding.
      lookup(host, _options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) { callback(error, '', 4); return; }
          if (!addresses.length || addresses.some(a => !publicImageAddress(a.address))) { callback(new Error('Private image destination'), '', 4); return; }
          const chosen = addresses.find(a => a.family === 4) ?? addresses[0]!;
          callback(null, chosen.address, chosen.family);
        });
      },
    }, response => {
      const status = response.statusCode ?? 500;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (!response.headers.location || redirects >= 3) { reject(new Error('Image redirect limit')); return; }
        try { resolve(downloadIcon(new URL(response.headers.location, url).href, signal, redirects + 1)); }
        catch (error) { reject(error); }
        return;
      }
      if (status !== 200 || Number(response.headers['content-length']) > MAX_BYTES) {
        response.destroy(); reject(new Error('Image unavailable')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(new Error('Image exceeds byte limit')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.end();
  });
}

export async function normalizeIcon(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Invalid image size');
  // Never let SVGs reference remote resources, local files, entities or CSS imports.
  const text = bytes.toString('utf8');
  if (/<svg[\s>]/i.test(text) && (/<!DOCTYPE|<!ENTITY|@import/i.test(text) ||
      /(?:href|src)\s*=\s*['"](?!#)[^'"]+/i.test(text) ||
      [...text.matchAll(/url\(([^)]*)\)/gi)].some(match => !match[1]!.trim().replace(/^['"]|['"]$/g, '').startsWith('#')))) throw new Error('External SVG resources');
  const image = sharp(bytes, { limitInputPixels: 4_000_000, animated: false, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp', 'avif', 'gif', 'svg'].includes(metadata.format ?? '') || !metadata.width || !metadata.height) throw new Error('Unsupported token image');
  const result = await image.timeout({ seconds: 3 }).rotate().resize(128, 128, { fit: 'contain', background: '#00000000' }).webp({ quality: 85 }).toBuffer();
  if (result.length > 64 * 1024) throw new Error('Token image too large');
  return result;
}
