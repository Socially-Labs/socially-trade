import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DbPool } from '@socially/db';
import { marketRedis } from '@socially/market-stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ApiFault } from './errors.js';
import { downloadIcon, iconCandidates, normalizeIcon } from './token-icon-download.js';

const TTL = 7 * 86400;
export interface IconCache {
  read(mint: string): Promise<Buffer | 'missing' | 'unavailable' | null>;
  write(mint: string, value: Buffer | 'missing' | 'unavailable'): Promise<void>;
  restore?(mint: string): Promise<Buffer | null>;
  claim(mint: string, owner: string): Promise<boolean>;
  release(mint: string, owner: string): Promise<void>;
  close(): void;
}

/** Shared Redis delivery cache and durable, processed-only S3 objects. */
export class SharedIconCache implements IconCache {
  private redis = process.env.REDIS_URL ? marketRedis(process.env.REDIS_URL) : undefined;
  private bucket = process.env.S3_ASSET_BUCKET;
  private s3 = this.bucket ? new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED' }) : undefined;
  private key(mint: string) { return `socially:token-icon:v1:${mint}`; }
  private async ready() {
    for (let i = 0; this.redis && this.redis.status !== 'ready' && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 25));
  }
  async read(mint: string) {
    await this.ready();
    const cached = await this.redis?.get(this.key(mint));
    if (cached === 'missing' || cached === 'unavailable') return cached;
    if (cached) return Buffer.from(cached, 'base64');
    return null;
  }
  async restore(mint: string) {
    if (this.s3) try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: `token-icons/v1/${mint}.webp` }), { abortSignal: AbortSignal.timeout(2500) });
      if (response.Body && response.ContentLength && response.ContentLength <= 65536 && response.LastModified && Date.now() - response.LastModified.getTime() < TTL * 1000) {
        const bytes = Buffer.from(await response.Body.transformToByteArray());
        await this.cacheValue(mint, bytes.toString('base64'), Math.max(1, TTL - Math.floor((Date.now() - response.LastModified.getTime()) / 1000)));
        return bytes;
      }
      if (response.Body && 'destroy' in response.Body) response.Body.destroy();
    } catch { /* S3 is optional; Redis still shares validated images. */ }
    return null;
  }
  private async cacheValue(mint: string, value: string, ttl: number) {
    await this.redis?.eval(`
      redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2])
      redis.call('ZADD',KEYS[2],ARGV[3],KEYS[1])
      local excess=redis.call('ZCARD',KEYS[2])-4096
      if excess>0 then
        local old=redis.call('ZPOPMIN',KEYS[2],excess)
        for i=1,#old,2 do redis.call('DEL',old[i]) end
      end
      redis.call('EXPIRE',KEYS[2],691200)
      return 1`, 2, this.key(mint), 'socially:token-icon:v1:index', value, ttl, Date.now());
  }
  async write(mint: string, value: Buffer | 'missing' | 'unavailable') {
    await this.cacheValue(mint, Buffer.isBuffer(value) ? value.toString('base64') : value,
      Buffer.isBuffer(value) ? TTL : value === 'missing' ? 21600 : 30);
    if (Buffer.isBuffer(value) && this.s3) try {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: `token-icons/v1/${mint}.webp`, Body: value, ContentType: 'image/webp', CacheControl: 'public, max-age=86400' }), { abortSignal: AbortSignal.timeout(2500) });
    } catch { /* Retry durable publication on a later cache miss; never break an image already cached in Redis. */ }
  }
  async claim(mint: string, owner: string) {
    if (!this.redis) return true;
    if (!await this.redis.set(`${this.key(mint)}:lock`, owner, 'PX', 25000, 'NX')) return false;
    const count = Number(await this.redis.eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n", 1, 'socially:token-icon:miss-budget'));
    if (count > 60) { await this.release(mint, owner); return false; }
    return true;
  }
  async release(mint: string, owner: string) {
    await this.redis?.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, `${this.key(mint)}:lock`, owner);
  }
  close() { this.redis?.disconnect(); this.s3?.destroy(); }
}

export class TokenIcons {
  private memory = new Map<string, { until: number; value: Buffer | 'missing' | 'unavailable' }>();
  private pending = new Map<string, Promise<Buffer>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private source: (mint: string) => Promise<string | null>, private cache: IconCache,
    private gateways = (process.env.TOKEN_ICON_IPFS_GATEWAYS ?? 'https://ipfs.filebase.io/ipfs/,https://gateway.pinata.cloud/ipfs/').split(',').map(s => s.trim()).filter(Boolean),
    private download = downloadIcon) {}
  close() { this.cache.close(); }
  private result(value: Buffer | 'missing' | 'unavailable'): Buffer {
    if (value === 'missing') throw new ApiFault(404, 'token_icon_missing', 'No token image is available');
    if (value === 'unavailable') throw new ApiFault(503, 'token_icon_unavailable', 'Token image is temporarily unavailable');
    return value;
  }
  private remember(mint: string, value: Buffer | 'missing' | 'unavailable') {
    if (this.memory.size >= 256) this.memory.delete(this.memory.keys().next().value!);
    this.memory.set(mint, { value, until: Date.now() + (Buffer.isBuffer(value) ? 3600000 : value === 'missing' ? 21600000 : 30000) });
  }
  async get(mint: string): Promise<Buffer> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new ApiFault(400, 'invalid_mint', 'Invalid token mint');
    const local = this.memory.get(mint);
    if (local && local.until > Date.now()) return this.result(local.value);
    const pending = this.pending.get(mint); if (pending) return pending;
    if (this.pending.size >= 64) throw new ApiFault(503, 'token_icons_busy', 'Token images are updating');
    const work = this.load(mint).finally(() => this.pending.delete(mint));
    this.pending.set(mint, work); return work;
  }
  private async load(mint: string) {
    const existing = await this.cache.read(mint);
    if (existing) { this.remember(mint, existing); return this.result(existing); }
    // Cache hits do not compete with downloads. Cold lists queue a bounded number
    // of misses while at most four images download/decode on this API process.
    await this.slot();
    const owner = randomUUID();
    let claimed = false;
    try {
      claimed = await this.cache.claim(mint, owner);
      if (!claimed) throw new ApiFault(503, 'token_icons_busy', 'Token images are updating');
      // Only catalog metadata can choose an upstream URL; callers never supply URLs.
      const source = await this.source(mint);
      if (!source) { await this.cache.write(mint, 'missing'); this.remember(mint, 'missing'); return this.result('missing'); }
      // Durable storage reads also require known metadata and miss admission, so
      // arbitrary public requests cannot fan out into unbounded S3 operations.
      const stored = await this.cache.restore?.(mint);
      if (stored) { this.remember(mint, stored); return stored; }
      let candidates: string[];
      try { candidates = iconCandidates(source, this.gateways); } catch { candidates = []; }
      for (const candidate of candidates) {
        let bytes: Buffer;
        try { bytes = await normalizeIcon(await this.download(candidate, AbortSignal.timeout(3500))); }
        catch { continue; }
        await this.cache.write(mint, bytes); this.remember(mint, bytes); return bytes;
      }
      await this.cache.write(mint, 'unavailable'); this.remember(mint, 'unavailable'); return this.result('unavailable');
    } finally {
      try { if (claimed) await this.cache.release(mint, owner); }
      finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
    }
  }
  private async slot() {
    if (this.active < 4) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter(item => item !== ready);
        reject(new ApiFault(503, 'token_icons_busy', 'Token images are updating'));
      }, 10000);
      this.waiting.push(ready);
    });
  }
}

export function registerTokenIconRoutes(app: FastifyInstance, db: () => DbPool) {
  let service: TokenIcons | undefined;
  app.get<{ Params: { mint: string } }>('/v1/markets/:mint/icon', async (req, reply) => {
    service ??= new TokenIcons(async mint => (await db().query<{ icon: string | null }>(
      "SELECT payload->>'icon' AS icon FROM market_token_metadata WHERE mint=$1", [mint])).rows[0]?.icon ?? null, new SharedIconCache());
    try {
      const bytes = await service.get(req.params.mint);
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
      reply.header('cache-control', 'public, max-age=86400, stale-while-revalidate=604800').header('etag', etag).header('x-content-type-options', 'nosniff');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.type('image/webp').send(bytes);
    } catch (error) {
      reply.header('cache-control', 'no-store');
      if (error instanceof ApiFault && error.statusCode === 503) reply.header('retry-after', '3');
      throw error;
    }
  });
  app.addHook('onClose', async () => service?.close());
}
