# Token image delivery

`GET /v1/markets/:mint/icon` is public and accepts a base58 Solana mint, never an
arbitrary image URL. The API resolves the existing `market_token_metadata.icon`;
this endpoint does not call Jupiter or consume the market-data key quota.

The APK maps non-null logos from discovery, token detail, legacy token lists and
saved markets onto this endpoint using its configured API origin. Missing logos
retain the existing initials/local-token fallback. Temporary download failures
retry twice, after roughly 4 and 12 seconds with jitter, and timers stop when the
icon unmounts. The server sends `Retry-After: 3` on temporary errors.

## Cache and storage

- Up to 256 processed icons in process memory for one hour.
- Redis shares processed bytes for seven days, bounded to 4,096 entries. Missing
  metadata is cached for six hours; failed upstream images for 30 seconds.
- The existing `S3_ASSET_BUCKET` stores processed images under
  `token-icons/v1/<mint>.webp`, using the existing AWS region/credentials. These
  objects restore Redis after eviction/restart. Objects older than seven days
  refresh from metadata rather than pinning an old logo indefinitely.
- Responses are `image/webp`, 128×128, at most 64 KiB, with an ETag and a one-day
  public browser/CDN cache lifetime. Matching `If-None-Match` returns 304.

S3 is optional; when unavailable, Redis continues serving validated images. With
neither configured, only the bounded process cache is available. A CDN can cache
the stable API path without exposing arbitrary upstream URLs. No migration is
required. The bucket's API role needs GetObject/PutObject for `token-icons/v1/*`.

## Upstream resolution and limits

`TOKEN_ICON_IPFS_GATEWAYS` is a comma-separated list of HTTPS gateway prefixes
ending in `/ipfs/`. Defaults are Filebase then Pinata. Path-style and subdomain
IPFS URLs preserve their CID and asset path; the original source is tried last,
with at most three candidates and a 3.5-second deadline per candidate. Configure
your own gateway service for production reliability; public gateways can still
fail or lack content. A gateway fallback cannot recover unprovided IPFS data.

Cold downloads coalesce per mint, queue at most 64 requests locally, and process
at most four images concurrently. Waiting for a slot is bounded to ten seconds.
Redis leases prevent simultaneous cross-instance downloads, with at most 60
admitted cache misses per minute across instances, including durable restores.
Catalog lookup and S3 operations happen only after miss admission. Warm hits need
no database or upstream request. Without Redis, the local bounds still apply.

The downloader restricts HTTPS/public destinations, validates and pins DNS
addresses, revalidates redirects, limits response bytes to 2 MiB and decodes with
pixel/time limits. SVG external resources/entities are rejected. Accepted images
are re-encoded as WebP rather than forwarding active markup or untrusted MIME.

Verification: API build; `node --test apps/api/test/token-icons.test.mjs`; APK
lint/typecheck and `pnpm test:market-api`. Live verification recovered SOL, PUMP
and cbBTC, confirmed 304 repeat responses, matching Redis/S3 bytes, and rendered
cached logos in the Captain browser preview. Android device verification remains
a reload check on a connected phone.
