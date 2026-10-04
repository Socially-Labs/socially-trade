# Captain profile and banner assets

## Implemented endpoints

Captain images are public profile metadata. PostgreSQL stores `avatar_url` and `banner_url`; the image files live in an external object store. No asset store or file-upload service is currently configured in this repository.

### Update a profile

`PATCH /v0/captains/:captainId`

- Requires `Authorization: Bearer <Privy access token>`.
- `captainId` is the local user UUID returned during account bootstrap, also the Captain's ID.
- Only that Captain may update their existing profile. Another user receives `403 captain_profile_forbidden`; a missing profile receives `404 captain_not_found`.
- JSON body must contain at least one of `bio`, `avatarUrl`, `bannerUrl`. Unknown fields are rejected.
- `bio` is a string up to 500 characters; send `""` to clear it.
- Image URLs are permanent HTTPS strings up to 2,048 characters. Credentials, nonstandard ports, query strings and fragments are rejected. Signed download/upload URLs must not be stored as profile URLs.
- An omitted field keeps its value. `null` removes an image. Empty image strings are invalid.
- No idempotency header is required. Applying the same body repeatedly has the same result. Concurrent updates to the same field use the last database write; partial updates preserve other fields.

```http
PATCH /v0/captains/00000000-0000-4000-8000-000000000001
Authorization: Bearer <Privy access token>
Content-Type: application/json
```

```json
{
  "bio": "Trading SOL with a steady risk budget.",
  "avatarUrl": "https://assets.example.com/captains/00000000-0000-4000-8000-000000000001/avatar/asset-id.webp",
  "bannerUrl": "https://assets.example.com/captains/00000000-0000-4000-8000-000000000001/banner/asset-id.webp"
}
```

Success `200`:

```json
{
  "userId": "00000000-0000-4000-8000-000000000001",
  "handle": "captainname",
  "bio": "Trading SOL with a steady risk budget.",
  "avatarUrl": "https://assets.example.com/captains/00000000-0000-4000-8000-000000000001/avatar/asset-id.webp",
  "bannerUrl": "https://assets.example.com/captains/00000000-0000-4000-8000-000000000001/banner/asset-id.webp"
}
```

Remove only a banner with `{ "bannerUrl": null }`.

`GET /v0/captains/:captainId` returns the same full public DTO. `POST /v0/captains` also returns `avatarUrl` and `bannerUrl`; new profiles have null images, while an existing-profile replay returns its current images. The create endpoint still accepts only `handle` and optional `bio`; create first, then PATCH image metadata.

Validation errors use the existing `invalid_request` response. Invalid image URL structure returns `400 invalid_asset_url`. If a configured allowed origin does not match, return `400 asset_origin_forbidden`. Existing Privy configuration/auth errors remain unchanged. The API stores URLs without fetching them; it does not verify file existence, MIME type, dimensions, byte size or ownership of the external object.

## Where to save the files

**Recommendation: Cloudflare R2**, served through a production custom domain such as `assets.<your-domain>`. Domain name and bucket must be provisioned; `assets.example.com` above is illustrative. R2 custom domains support Cloudflare caching; `r2.dev` public access is intended for development. See [Cloudflare public bucket documentation](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Suggested object keys:

```text
captains/<captain-user-id>/avatar/<random-asset-id>.webp
captains/<captain-user-id>/banner/<random-asset-id>.webp
```

Use a new key for every replacement so cached old files do not overwrite the new image. Profile/banner assets are public; use a separate bucket for anything private. S3 or another object store/CDN can also supply permanent HTTPS URLs without changing this endpoint.

### Current setup

1. Apply database migration `012_captain_profile_images.sql` using `pnpm --filter @socially/db migrate`.
2. Provision the asset bucket and its HTTPS delivery domain outside this repository.
3. Upload approved images through your storage administration tooling or existing upload service.
4. Set optional API environment variable `CAPTAIN_ASSET_ORIGINS=https://assets.<your-domain>` to restrict saved URLs to that exact origin. Comma-separated origins are supported. Omit trailing slashes. If unset, any otherwise valid HTTPS URL is accepted.
5. PATCH the permanent public URL into the Captain profile, then render the URLs returned by GET. Use a client placeholder for null images.

No R2 credentials are needed by this metadata endpoint. Object-store write credentials belong only on trusted servers or storage administration tools.

### Future self-service upload integration

The file-upload step is **not implemented** by these endpoints. For users selecting files inside the app, add a server-issued upload flow:

1. Authenticate the Captain and reserve an object under their own Captain ID.
2. Issue a short-lived upload URL for that object.
3. Client uploads the bytes to storage.
4. A completion step verifies size, image type and processing results before accepting the asset.
5. Save the resulting permanent delivery URL through this profile endpoint, or link a verified asset ID instead.

R2 supports [presigned PUT uploads](https://developers.cloudflare.com/r2/api/s3/presigned-urls/). These upload URLs use the R2 S3 API endpoint, while the saved public image URL uses the delivery domain. Browser uploads require an appropriate [bucket CORS policy](https://developers.cloudflare.com/r2/buckets/cors/). Validate image bytes in the upload pipeline; URL validation cannot establish that a file is a safe raster image. Plan cleanup for failed uploads and replaced, unreferenced objects.

## Validation status

Implementation compilation and workspace type checks are recorded separately. No live storage provisioning, upload, authentication or database simulation was performed for this feature. Existing records gain null image columns when migration 012 runs.
