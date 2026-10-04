# Captain image storage and CDN costs

Rates checked October 5, 2026. USD, before tax. These estimates cover Captain avatar/banner assets, not the API server, PostgreSQL, Redis, market data, or other app infrastructure.

## Region and billing model

S3 staging and processed image buckets use Osaka (`ap-northeast-3`). CloudFront is a global CDN: it routes users to edge locations and charges pay-as-you-go delivery rates for those locations. There is no Osaka-only CDN configuration. The provisioned distribution uses pay-as-you-go pricing; no flat-rate plan was purchased.

## Rates

| Component | Rate |
| --- | --- |
| Osaka S3 Standard, first 50 TB | $0.025 per GB-month |
| Osaka S3 PUT/COPY/POST/LIST | $0.0047 per 1,000 requests |
| Osaka S3 GET/HEAD | $0.00037 per 1,000 requests |
| S3 DELETE | Free |
| CloudFront India delivery, first 10 TB paid tier | $0.109 per GB |
| CloudFront Japan delivery, first 10 TB paid tier | $0.114 per GB |
| CloudFront HTTPS requests, India/Japan | $0.012 per 10,000 requests |
| AWS S3 origin transfer to CloudFront | Free |

CloudFront pay-as-you-go includes 1 TB of transfer and 10 million HTTP/HTTPS requests per month across the account. Other distributions consume the same allowance; this is not an allowance per distribution. S3 requests/storage are separate charges. Account credits/discounts were not assumed in the S3 estimates.

Rates were retrieved from the AWS Price List API: AmazonS3 Osaka usage types `APN3-TimedStorage-ByteHrs`, `APN3-Requests-Tier1`, `APN3-Requests-Tier2`; AmazonCloudFront usage types `IN-DataTransfer-Out-Bytes`, `JP-DataTransfer-Out-Bytes`, `IN-Requests-Tier2-HTTPS`, `JP-Requests-Tier2-HTTPS`.

Sources: [S3 pricing](https://aws.amazon.com/s3/pricing/), [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/), [CloudFront free tier FAQ](https://aws.amazon.com/cloudfront/faqs/), [AWS Price List GetProducts API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html), [AWS origin transfer to CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/).

## How our flow is billed

Each completed image normally incurs two S3 PUTs (original and processed WebP), one HEAD and one GET to validate the original, then a free DELETE of the original. Requests that miss CloudFront's cache incur another S3 GET. Cached image views still count as CloudFront requests and delivery bytes. Abandoned originals expire after one day; retained processed image versions continue to contribute storage.

Estimate:

```text
S3 = average stored GB × 0.025
   + (2 × completed uploads + other PUT/LIST requests) / 1,000 × 0.0047
   + (2 × completed uploads + cache misses + other GET/HEAD requests) / 1,000 × 0.00037

CloudFront for India viewers, within first paid tier:
  max(0, delivered GB - remaining account free GB) × 0.109
  + max(0, HTTPS requests - remaining account free requests) / 10,000 × 0.012
```

## Illustrative monthly budgets

Assumptions: all remaining CloudFront free allowance is available to this app; 90% cache hit rate; viewers served from India; no retries/additional request charges; average total storage includes staging and retained processed images. Treat these as usage scenarios, not a forecast of user count.

| Scenario | Stored | Delivered | Image views | Completed uploads | Estimated total/month |
| --- | --- | --- | --- | --- | --- |
| Small v0 | 10 GB | 100 GB | 1 million | 10,000 | $0.39 |
| Growing v0 | 100 GB | 500 GB | 5 million | 50,000 | $3.19 |
| Larger traffic | 100 GB | 2,048 GB | 20 million | 100,000 | $127.87 |

The first two scenarios have no CloudFront charge because they fit the assumed remaining account free allowance. If that allowance has already been consumed elsewhere, their CloudFront charges would add approximately $12.10 and $60.50 respectively for India delivery.

The larger scenario includes about $111.62 for paid transfer, $12 for paid HTTPS requests, and $4.25 for S3. Japan delivery at that volume would add approximately $5.12 compared with India, assuming the same free allowance.

Optional CloudFront flat-rate plans currently advertise Free ($0/month, 100 GB/1M requests) and Pro ($15/month, 50 TB/10M requests). They have different features and eligibility; they are not enabled for this deployment and their allowances must not be combined with the pay-as-you-go free tier. Re-evaluate the billing model before traffic grows.

## Other costs to account for

- Image processing uses the API server's CPU/memory; compute is outside these estimates.
- S3 staging reads by an API hosted outside the bucket region may incur transfer fees. Colocate processing with Osaka where practical.
- Old processed image versions are retained, so storage can exceed the size of the current avatar/banner set.
- Logging, custom DNS, WAF, paid support, taxes, retries, and account-wide usage may change the bill. They are not included here.
- The previous empty US-region stack is retained. An unused pay-as-you-go distribution has no fixed monthly CDN charge, but any future storage, requests or traffic there would be billed separately.
