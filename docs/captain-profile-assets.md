# Captain profile image uploads

## Status

The backend implements authenticated upload reservations, presigned direct uploads to a private AWS S3 staging bucket, image validation/processing, publication to a separate private processed bucket served publicly through CloudFront and automatic profile attachment. No frontend is included.

Local PostgreSQL has been started and migrations through **013** applied. Workspace builds and type checks pass. **AWS storage was provisioned on October 5, 2026:** the CloudFormation stack reached `CREATE_COMPLETE`, CloudFront reports `Deployed`, and the local ignored `.env` contains the storage settings. Live authenticated upload verification is still pending.

### Provisioned storage

| Setting | Deployed value |
| --- | --- |
| Stack | `socially-captain-assets` |
| Region | `us-east-1` |
| Staging bucket | `socially-captains-420053132650-us-east-1-uploads` |
| Processed bucket | `socially-captains-420053132650-us-east-1-assets` |
| Delivery origin | `https://d3t09o1mis44fs.cloudfront.net` |
| Distribution | `E1UWF4WP98P6XW` |

AWS configuration reads confirmed that the processed bucket blocks public access and its policy is not public, staging CORS allows PUT from `http://localhost:3000`, and pending originals expire after one day. These are infrastructure checks, not evidence of a completed user upload.

The deployment used the currently authenticated default AWS CLI profile. Configure the API host with its own IAM role and the runtime permissions below; the local sign-in session is temporary. Copy the non-secret storage settings into the API deployment environment and restart the API. Set `S3_UPLOAD_ORIGINS` to the actual browser app origins and rerun setup before shipping a web client; the current origin is for local integration. Native mobile clients do not use browser CORS. This checkpoint provisions storage and ships backend code; it does not deploy an API host.

## Client flow

1. Bootstrap through Privy and create a Captain profile. Captain ID is the local user UUID.
2. Request an upload URL with a Privy access token.
3. PUT the actual image file into the private staging bucket using that URL.
4. Call the completion endpoint with the same user token.
5. Completion validates the bytes, converts them to WebP, publishes the processed image and updates the Captain profile. Render the returned permanent public URL.

### 1. Reserve an upload

`POST /v0/captains/:captainId/assets/uploads`

```json
{"kind":"avatar","contentType":"image/png","byteSize":123456}
```

Allowed kinds: `avatar`, `banner`. Allowed types: `image/jpeg`, `image/png`, `image/webp`. Size must be an integer from 1 to 5,242,880 bytes (5 MiB). Only the existing profile's owner can reserve an upload. Maximum 20 reservations per Captain per rolling hour; rejected/unused reservations still count.

Success `201`:

```json
{
  "uploadId":"00000000-0000-4000-8000-000000000002",
  "kind":"avatar",
  "method":"PUT",
  "uploadUrl":"<short-lived S3 signed URL>",
  "headers":{"Content-Type":"image/png"},
  "byteSize":123456,
  "uploadUrlExpiresAt":"2026-10-05T00:05:00.000Z",
  "completeBefore":"2026-10-05T00:10:00.000Z"
}
```

Upload URL lasts five minutes. Complete within ten minutes of the reservation. The signed request binds content type and content length. Upload exactly the file bytes: no multipart wrapper, no base64, no JSON. A browser supplies Content-Length from a File/Blob automatically; native clients must supply the correct length. Do not send the Privy token to S3. Do not log or permanently store upload URLs.

```javascript
const reservation = await fetch(`${api}/v0/captains/${captainId}/assets/uploads`, {
  method: "POST",
  headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "avatar", contentType: file.type, byteSize: file.size })
});
if (!reservation.ok) throw new Error("Unable to reserve image upload");
const upload = await reservation.json();
const put = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.headers, body: file });
if (!put.ok) throw new Error("Unable to upload image");
const completion = await fetch(`${api}/v0/captains/${captainId}/assets/uploads/${upload.uploadId}/complete`, {
  method: "POST", headers: { Authorization: `Bearer ${accessToken}` }
});
if (!completion.ok) throw new Error("Unable to complete image upload");
const { profile, asset } = await completion.json();
```

### 2. Complete and attach

`POST /v0/captains/:captainId/assets/uploads/:uploadId/complete`

Privy bearer authentication required; no request body or idempotency header. Only the reserving Captain can complete it. Owner-scoped upload lookup and a database row lock serialize retries.

Success `200`:

```json
{
  "asset":{"id":"00000000-0000-4000-8000-000000000002","kind":"avatar","url":"https://assets.example.com/captains/<captainId>/avatar/<uploadId>.webp"},
  "profile":{"userId":"<captainId>","handle":"captainname","bio":"","avatarUrl":"https://assets.example.com/captains/<captainId>/avatar/<uploadId>.webp","bannerUrl":null}
}
```

A completed retry returns the original asset and the **current** profile. It does not reattach an older image after a newer one has been selected. Different uploads completing concurrently use the last completed database profile write for that image kind.

The backend checks declared size/type against storage metadata, reads no more than 5 MiB, checks actual decoded format, rejects multiple frames and images below 32 pixels on either side or above 8,192 on either side, and limits decoded input to 16 million pixels. It uses ETag matching to prevent validation against a different version of the staging object.

Output: 512×512 avatar or 1,600×600 banner, center-cropped WebP at quality 85, oriented from source metadata with metadata stripped. Processing has a five-second image timeout and allows four concurrent publications per API instance. Public output keys are unique per reservation and carry immutable one-year cache headers. Unverified originals never go into the public bucket.

Published bytes precede the database attachment. If the database commit fails, completion can retry safely, but an unreferenced processed object can remain. Valid previous images are retained for reattachment; automatic deletion of retired public images is not enabled. Plan an audit/retention job for public orphans and old reservation records as usage grows.

### Errors

| Code / status | Handling |
| --- | --- |
| `invalid_request` / 400 | Correct body, UUID, type or size |
| `unauthorized` / 401 | Refresh Privy access token |
| `captain_profile_forbidden` / 403 | Use the owning Captain account |
| `captain_not_found` / 404 | Create Captain profile first |
| `asset_upload_not_found` / 404 | Use an upload reserved by that account |
| `upload_not_found` / 409 | Finish PUT before completion |
| `upload_changed` / 409 | Retry completion after upload finishes |
| `asset_upload_expired` / 410 | Reserve and upload again |
| `upload_rate_limited` / 429 | Wait for the hourly reservation budget |
| `invalid_image` / 400 | Choose a supported valid raster image |
| `image_processing_busy` / 503 | Retry completion with backoff |
| `asset_storage_unconfigured` / 503 | Configure server storage |
| `asset_storage_unavailable` / 503 | Retry after storage recovers |

Malformed image bytes do not update the profile. Staging cleanup runs best effort after a successful commit; bucket lifecycle expires remaining `pending/` files after one day.

## Profile reads and edits

`GET /v0/captains/:captainId` returns `{userId,handle,bio,avatarUrl,bannerUrl}` publicly. New `POST /v0/captains` profiles start with null image fields; existing create replays return current fields.

`PATCH /v0/captains/:captainId` still supports partial `{bio,avatarUrl,bannerUrl}` changes with owner authentication. Omit fields to keep them; send null to remove an image or an empty bio string to clear the bio. Bio maximum 500 characters; body cannot be empty. Unknown fields are rejected.

**Non-null image URLs must now belong to a completed upload owned by that Captain for that image kind.** Arbitrary external URLs return `400 asset_not_verified`. This tightens the earlier URL-only contract; existing legacy URLs remain readable until cleared/replaced. HTTPS/query/credential validation and optional `CAPTAIN_ASSET_ORIGINS` restrictions still apply. Completion attaches a verified image automatically, so PATCH is only needed to clear/reselect it or edit bio.

## AWS storage setup

The infrastructure is defined in [infra/captain-assets.aws.yaml](../infra/captain-assets.aws.yaml), managed by a dedicated CloudFormation stack. There is no Cloudflare dependency.

- Private staging bucket: original uploads under `pending/`, presigned PUT, app-origin CORS and one-day expiration.
- Private processed bucket: verified WebP assets under `captains/`, encrypted and public access blocked.
- CloudFront distribution: public HTTPS delivery on its AWS-provided `cloudfront.net` domain. Origin Access Control signs requests to S3; the bucket policy allows only this distribution to read processed assets. Direct anonymous S3 reads stay blocked.
- Bucket names include the stack's prefix, AWS account ID and region to avoid global-name collisions. Buckets are retained if the stack is removed or a replacement is attempted.

AWS supports [presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html) and [CloudFront Origin Access Control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html). The setup uses an AWS-provided delivery domain; custom domains/ACM certificates are optional future configuration.

### Authentication and environment

Local development uses the existing AWS profile through the SDK's default credential chain. Renew an expired session with `aws login`; for an SSO profile use `aws sso login --profile <profile>`. Production API processes should use an IAM role with the object permissions below. No application-specific long-lived access key is required. The installed JavaScript SDK supports [AWS login credentials](https://docs.aws.amazon.com/sdkref/latest/guide/feature-login-credentials.html).

| Variable | Purpose |
| --- | --- |
| `AWS_REGION` | Bucket/stack region; current setup default `us-east-1` |
| `AWS_PROFILE` | Optional local profile selection; omit for the default profile or production IAM role |
| `ASSET_STACK_NAME` | Dedicated CloudFormation stack; default `socially-captain-assets` |
| `ASSET_BUCKET_PREFIX` | Stable bucket name prefix; default `socially-captains`; changing deployed bucket names requires a data migration |
| `S3_UPLOAD_ORIGINS` | Exact comma-separated app/browser origins; default `http://localhost:3000`, HTTPS required in production |
| `S3_ASSET_BUCKET` | Processed bucket name, written by setup |
| `S3_UPLOAD_BUCKET` | Private staging bucket name, written by setup |
| `ASSET_PUBLIC_BASE_URL` | HTTPS CloudFront delivery origin, written by setup |
| `ASSET_DISTRIBUTION_ID` | CloudFront distribution ID, written by setup; not required by the upload runtime |
| `CAPTAIN_ASSET_ORIGINS` | Written by setup to restrict profile URLs to the CloudFront origin |

### Provisioning

```sh
aws login
pnpm --filter @socially/api assets:setup
```

The setup script loads the root `.env` and calls the AWS CLI using its configured credentials. Its first run starts the CloudFormation stack without a long blocking wait. CloudFront deployment can take several minutes. Rerun the same setup command after the stack reaches `CREATE_COMPLETE`; it saves the output bucket names and delivery origin to `.env`. Updates likewise require a rerun after `UPDATE_COMPLETE`. Repeated runs reuse the tagged stack and report no changes when already configured.

It refuses unrelated stacks and a changed bucket prefix. It does not print credentials. A failed/rolled-back stack must be inspected through CloudFormation events; the script never deletes it or retained buckets automatically. Stack creation requires CloudFormation, S3 configuration and CloudFront create/configure permissions. No IAM user or role is created by this stack.

Restart the API with environment values loaded by your deployment/process manager. Apply migrations through 013 on each deployed database. Local migrations through 013 have already been applied in this workspace.

### Runtime IAM permissions

Grant the API role only these object operations:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::<upload-bucket>/pending/*`.
- `s3:PutObject` on `arn:aws:s3:::<processed-bucket>/captains/*`.
- `s3:ListBucket` on the staging bucket, allowing missing upload HEAD requests to return 404 rather than 403.

S3 HeadObject uses GetObject permission. The API never needs CloudFormation or CloudFront administration permissions. CloudFront read access is supplied by the stack's processed-bucket policy, separate from the API role. Bucket encryption uses AES256, so no KMS key permission is needed.

## Verification still pending

Live signed PUT (including browser CORS/Content-Length signing), decoded image publication, CloudFront image delivery, token/owner denial, retries and expiration still need runtime verification with an authenticated Captain. Cloud infrastructure is deployed; these user flows have not been exercised against it. No new test suite has been run in this implementation checkpoint.
