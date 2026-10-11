import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(new URL('../apps/api/package.json',import.meta.url));
const {S3Client,GetBucketPolicyCommand,PutBucketPolicyCommand}=require('@aws-sdk/client-s3');
const Bucket=process.env.S3_ASSET_BUCKET;
if(!Bucket)throw new Error('S3_ASSET_BUCKET is required');
const client=new S3Client({region:process.env.AWS_REGION||process.env.AWS_DEFAULT_REGION,maxAttempts:2});
try {
  const {Policy}=await client.send(new GetBucketPolicyCommand({Bucket}));
  const policy=JSON.parse(Policy);
  const statement=policy.Statement.find(s=>s.Sid==='AllowCloudFrontVerifiedImages');
  if(!statement||statement.Effect!=='Allow'||statement.Principal?.Service!=='cloudfront.amazonaws.com'||statement.Action!=='s3:GetObject'||!statement.Condition?.StringEquals?.['AWS:SourceArn'])throw new Error('Unexpected policy; inspect manually before changing it');
  const resources=Array.isArray(statement.Resource)?statement.Resource:[statement.Resource];
  const captain=resources.find(r=>r===`arn:aws:s3:::${Bucket}/captains/*`);
  if(!captain)throw new Error('Expected scoped captain resource missing');
  const vault=captain.replace('/captains/*','/vaults/*');
  if(resources.includes(vault)){console.log('Vault media policy is already configured.');}
  else {
    statement.Resource=[...resources,vault];
    console.log('Change: allow the existing CloudFront distribution to read vaults/*; preserve all other statements and conditions.');
    if(process.argv.includes('--apply')) {
      const backup=join(tmpdir(),`socially-asset-policy-${Date.now()}.json`);
      await writeFile(backup,Policy,{mode:0o600,flag:'wx'});
      // Avoid overwriting a policy edited since this read.
      const latest=await client.send(new GetBucketPolicyCommand({Bucket}));
      if(latest.Policy!==Policy)throw new Error('Policy changed concurrently; rerun after review');
      await client.send(new PutBucketPolicyCommand({Bucket,Policy:JSON.stringify(policy)}));
      console.log(`Applied scoped media access. Rollback policy saved at ${backup}`);
    } else console.log('Dry run only. Pass --apply to perform the repair.');
  }
} finally {client.destroy();}
