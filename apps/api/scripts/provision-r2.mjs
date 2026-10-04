import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) { console.error(`Missing environment values: ${missing.join(', ')}`); process.exit(1); }
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('Invalid Cloudflare account ID');
const publicBucket = process.env.R2_BUCKET || 'socially-captain-assets';
const stagingBucket = process.env.R2_UPLOAD_BUCKET || 'socially-captain-uploads';
if (publicBucket === stagingBucket || ![publicBucket,stagingBucket].every(name => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name))) throw new Error('Use two different valid dedicated bucket names');
const origins = (process.env.R2_UPLOAD_ORIGINS || 'http://localhost:3000').split(',').map(value => value.trim()).filter(Boolean);
for (const origin of origins) {
  const url = new URL(origin);
  if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('R2_UPLOAD_ORIGINS must contain exact HTTP(S) origins');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production upload origins must use HTTPS');
}
const domain = process.env.R2_CUSTOM_DOMAIN;
if (process.env.NODE_ENV === 'production' && !domain) throw new Error('R2_CUSTOM_DOMAIN and CLOUDFLARE_ZONE_ID are required in production');
if (domain && (!process.env.CLOUDFLARE_ZONE_ID || !/^[a-z0-9.-]+$/i.test(domain))) throw new Error('Configure a valid custom domain and CLOUDFLARE_ZONE_ID');
async function cf(method, resource, body, allowMissing = false) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets${resource}`, {
    method, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  if (allowMissing && response.status === 404) return null;
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} failed (HTTP ${response.status}); check account, R2 subscription and token permissions`);
  return data.result;
}
let client;
async function bucket(name) {
  const exists = await cf('GET', `/${name}`, undefined, true);
  if (!exists) { await cf('POST', '', { name }); console.log(`Created ${name}`); }
  else console.log(`Using dedicated bucket ${name}`);
  return !exists;
}
try {
  const createdPublic = await bucket(publicBucket);
  await bucket(stagingBucket);
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("Dedicated buckets created. Add bucket-scoped R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to .env and rerun setup before enabling delivery");
  }
  client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }, maxAttempts: 2 });
  // Refuse to expose unrelated objects in an existing bucket.
  if (!createdPublic) {
    let token;
    do {
      const listing = await client.send(new ListObjectsV2Command({ Bucket: publicBucket, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(15000) });
      if ((listing.Contents || []).some(object => !object.Key?.startsWith('captains/'))) throw new Error('Public bucket contains unrelated objects; use a new dedicated assets bucket');
      token = listing.NextContinuationToken;
    } while (token);
  }
  const stagingDomains = await cf('GET', `/${stagingBucket}/domains/custom`);
  if (!Array.isArray(stagingDomains.domains)) throw new Error('Unable to verify staging bucket privacy');
  if (stagingDomains.domains.some(value => value.enabled)) throw new Error('Staging bucket has a public custom domain; use a new private staging bucket');
  await cf('PUT', `/${stagingBucket}/domains/managed`, { enabled: false });
  const cors = await cf('GET', `/${stagingBucket}/cors`, undefined, true);
  const uploadRule = { id: 'socially-captain-upload', allowed: { origins, methods: ['PUT'], headers: ['content-type', 'content-length'] }, exposeHeaders: ['ETag'], maxAgeSeconds: 3600 };
  await cf('PUT', `/${stagingBucket}/cors`, { rules: [...(cors?.rules || []).filter(rule => rule.id !== uploadRule.id), uploadRule] });
  const lifecycle = await cf('GET', `/${stagingBucket}/lifecycle`, undefined, true);
  const cleanup = { id: 'socially-pending-expiry', enabled: true, conditions: { prefix: 'pending/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } };
  await cf('PUT', `/${stagingBucket}/lifecycle`, { rules: [...(lifecycle?.rules || []).filter(rule => rule.id !== cleanup.id), cleanup] });
  let base;
  if (domain) {
    const domains = await cf('GET', `/${publicBucket}/domains/custom`);
    if (!domains.domains?.some(value => value.domain === domain)) {
      await cf('POST', `/${publicBucket}/domains/custom`, { domain, enabled: true, zoneId: process.env.CLOUDFLARE_ZONE_ID });
    } else {
      await cf('PUT', `/${publicBucket}/domains/custom/${encodeURIComponent(domain)}`, { enabled: true });
    }
    await cf('PUT', `/${publicBucket}/domains/managed`, { enabled: false });
    base = `https://${domain}`;
  } else {
    const managed = await cf('PUT', `/${publicBucket}/domains/managed`, { enabled: true });
    base = `https://${managed.domain}`;
  }
  for (const Bucket of [publicBucket, stagingBucket]) await client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(15000) });
  const values = { R2_BUCKET: publicBucket, R2_UPLOAD_BUCKET: stagingBucket, R2_PUBLIC_BASE_URL: base, CAPTAIN_ASSET_ORIGINS: new URL(base).origin };
  let contents = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [name,value] of Object.entries(values)) {
    const regex = new RegExp(`^${name}=.*$`, 'm');
    contents = regex.test(contents) ? contents.replace(regex, `${name}=${value}`) : `${contents.trimEnd()}\n${name}=${value}\n`;
  }
  fs.writeFileSync(envPath, contents, { mode: 0o600 });
  console.log('Bucket configuration saved to .env. Restart the API with its environment loaded.');
  console.log(domain ? 'Custom-domain DNS/certificate readiness must be checked before rollout.' : 'Development r2.dev delivery enabled. Configure a custom domain before production.');
} catch (error) {
  // Avoid outputting provider responses, credentials or signed URLs.
  console.error(error instanceof Error && !('$metadata' in error) ? error.message : 'Storage provisioning failed; check bucket-scoped R2 credentials');
  process.exitCode = 1;
} finally { client?.destroy(); }
