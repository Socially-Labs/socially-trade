import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-northeast-3';
const stack = process.env.ASSET_STACK_NAME || 'socially-captain-assets-osaka';
const prefix = process.env.ASSET_BUCKET_PREFIX || 'socially-captains';
const origins = (process.env.S3_UPLOAD_ORIGINS || 'http://localhost:3000').split(',').map(value => value.trim()).filter(Boolean);
if (!/^[a-z][a-z0-9-]{1,18}[a-z0-9]$/.test(prefix) || !/^[A-Za-z][A-Za-z0-9-]{0,100}$/.test(stack)) throw new Error('Invalid asset bucket prefix or stack name');
if (!origins.length) throw new Error('At least one S3 upload origin is required');
for (const origin of origins) {
  const url = new URL(origin);
  if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('S3_UPLOAD_ORIGINS must contain exact HTTP(S) origins');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production upload origins must use HTTPS');
}
function aws(args) {
  try {
    const output = execFileSync('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], {
      encoding: 'utf8', env: process.env, timeout: 30_000, maxBuffer: 5 * 1024 * 1024, stdio: ['ignore','pipe','pipe'],
    });
    return output.trim() ? JSON.parse(output) : {};
  } catch (error) {
    const text = String(error.stderr || '');
    if (/expired|reauthenticate|credentials|SSO|login/i.test(text)) throw new Error('AWS credentials unavailable or expired. Run aws login (or aws sso login for an SSO profile), then rerun setup.');
    if (/does not exist/.test(text) && args[0] === 'cloudformation' && args[1] === 'describe-stacks') return null;
    if (/No updates are to be performed/.test(text)) return { noUpdates: true };
    throw new Error(`AWS ${args[0]} ${args[1]} failed; check region, permissions and CloudFormation events. No credentials were printed.`);
  }
}
const parameters = [{ ParameterKey: 'BucketPrefix', ParameterValue: prefix }, { ParameterKey: 'UploadOrigins', ParameterValue: origins.join(',') }];
try {
  aws(['sts', 'get-caller-identity']);
  const result = aws(['cloudformation', 'describe-stacks', '--stack-name', stack]);
  const deployed = result?.Stacks?.[0];
  const template = `file://${path.join(root,'infra/captain-assets.aws.yaml')}`;
  if (!deployed) {
    aws(['cloudformation', 'create-stack', '--stack-name', stack, '--template-body', template, '--parameters', JSON.stringify(parameters), '--tags', 'Key=Project,Value=socially-trade']);
    console.log('AWS asset stack creation started. Rerun assets:setup after CloudFormation reaches CREATE_COMPLETE; CloudFront deployment can take several minutes.');
    process.exit(0);
  }
  if (deployed.StackStatus.endsWith('_IN_PROGRESS')) {
    console.log(`Asset stack ${deployed.StackStatus}. Rerun assets:setup after it completes.`);
    process.exit(0);
  }
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(deployed.StackStatus)) throw new Error(`Asset stack status ${deployed.StackStatus}; inspect CloudFormation events before continuing.`);
  if (deployed.Parameters?.find(value => value.ParameterKey === 'BucketPrefix')?.ParameterValue !== prefix) throw new Error('Bucket prefix differs from the deployed stack. Keep the existing prefix; a bucket migration requires a separate data migration.');
  if (!deployed.Tags?.some(tag => tag.Key === 'Project' && tag.Value === 'socially-trade')) throw new Error('Refusing to modify a stack not tagged for socially-trade; use a new ASSET_STACK_NAME');
  const update = aws(['cloudformation', 'update-stack', '--stack-name', stack, '--template-body', template, '--parameters', JSON.stringify(parameters)]);
  if (!update.noUpdates) {
    console.log('AWS asset stack update started. Rerun assets:setup after UPDATE_COMPLETE.');
    process.exit(0);
  }
  const outputs = Object.fromEntries(deployed.Outputs.map(value => [value.OutputKey,value.OutputValue]));
  const values = { AWS_REGION: outputs.Region, S3_ASSET_BUCKET: outputs.AssetBucket, S3_UPLOAD_BUCKET: outputs.UploadBucket,
    ASSET_PUBLIC_BASE_URL: outputs.AssetBaseUrl, CAPTAIN_ASSET_ORIGINS: new URL(outputs.AssetBaseUrl).origin,
    ASSET_DISTRIBUTION_ID: outputs.DistributionId, ASSET_STACK_NAME: stack };
  let contents = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [name,value] of Object.entries(values)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid stack outputs');
    const regex = new RegExp(`^${name}=.*$`, 'm');
    contents = regex.test(contents) ? contents.replace(regex, `${name}=${value}`) : `${contents.trimEnd()}\n${name}=${value}\n`;
  }
  fs.writeFileSync(envPath, contents, { mode: 0o600 });
  console.log('AWS S3 and CloudFront settings saved to .env. Restart API with its environment loaded.');
  console.log(`Asset delivery: ${values.ASSET_PUBLIC_BASE_URL}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
