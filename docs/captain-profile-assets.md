# Captain profile image uploads

## Status

The backend implements authenticated upload reservations, presigned direct uploads to a private R2 bucket, image validation/processing, publication to a separate public bucket and automatic profile attachment. No frontend is included.

Local PostgreSQL has been started and migrations through **013** applied. Workspace builds and type checks pass. **Cloud provisioning and live upload verification remain blocked by missing Cloudflare/R2 credentials.** The setup script is implemented; writing it is not evidence that buckets exist.

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
  "uploadUrl":"<short-lived R2 signed URL>",
  "headers":{"Content-Type":"image/png"},
  "byteSize":123456,
  "uploadUrlExpiresAt":"2026-10-05T00:05:00.000Z",
  "completeBefore":"2026-10-05T00:10:00.000Z"
}
```

Upload URL lasts five minutes. Complete within ten minutes of the reservation. The signed request binds content type and content length. Upload exactly the file bytes: no multipart wrapper, no base64, no JSON. A browser supplies Content-Length from a File/Blob automatically; native clients must supply the correct length. Do not send the Privy token to R2. Do not log or permanently store upload URLs.

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

## Cloud storage setup

The files use Cloudflare R2. The setup creates two dedicated buckets:

- `socially-captain-uploads`: private originals; presigned PUT, browser CORS and one-day pending cleanup.
- `socially-captain-assets`: processed public WebP files; custom asset domain in production or `r2.dev` during development.

Cloudflare supports [S3-compatible presigned uploads](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [browser CORS](https://developers.cloudflare.com/r2/buckets/cors/) and [custom-domain delivery](https://developers.cloudflare.com/r2/buckets/public-buckets/). `r2.dev` is development access; configure a custom domain for production.

### Credentials needed

Put values in the root `.env` or deployment environment; never send secrets to the UI or commit them:

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account owning the R2 buckets |
| `CLOUDFLARE_API_TOKEN` | Setup-only token with R2 bucket-management permissions |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Runtime S3 credentials with object read/write permissions for both buckets, plus bucket read/list permissions used by setup |
| `R2_BUCKET` | Public processed bucket; defaults to `socially-captain-assets` during setup |
| `R2_UPLOAD_BUCKET` | Separate private bucket; defaults to `socially-captain-uploads` |
| `R2_UPLOAD_ORIGINS` | Exact comma-separated app/browser origins; default local `http://localhost:3000` |
| `R2_CUSTOM_DOMAIN`, `CLOUDFLARE_ZONE_ID` | Domain such as `assets.example.com` and its Cloudflare zone; required for production setup |
| `R2_PUBLIC_BASE_URL` | Written by setup; permanent HTTPS delivery origin |
| `CAPTAIN_ASSET_ORIGINS` | Written by setup to restrict profile image URLs to the delivery origin |

Enable R2 in your Cloudflare account first if it is not enabled. Create the runtime S3 credentials through [Manage R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/). The management token and S3 credentials have different roles. If the buckets do not exist yet, run setup with just the account ID and management token first: it creates the two private buckets and stops before public delivery. Then issue S3 credentials scoped to those two buckets and rerun setup to finish. The API process needs the account ID, S3 credentials, both bucket names and delivery URL; it does not need the management API token.

```sh
pnpm --filter @socially/api assets:setup
```

The script loads root `.env`, validates configuration, creates missing buckets, confirms an existing public bucket has no unrelated object keys, refuses a staging bucket with public custom domains, disables staging `r2.dev` access, merges its CORS/lifecycle rules, configures public delivery and checks S3 bucket access. It writes non-secret derived settings to `.env` and does not print credentials. Rerunning reuses buckets; it does not recreate them or erase existing data/rules. Public custom domain DNS/certificate readiness still needs confirmation after attachment.

Restart API with its environment loaded after setup. Apply migration 013 on each deployed database. The repository scripts do not automatically load `.env` for the API; your process/deployment manager must pass it.

## Verification still pending

Live R2 signed PUT (including browser CORS and Content-Length signing), decoded image publication, public domain delivery, token/owner denial, completion retries and expiration need runtime verification after credentials are supplied. Builds and applied migrations do not establish that external storage works. No new test suite has been run in this implementation checkpoint.
