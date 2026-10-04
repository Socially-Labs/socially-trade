import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from "sharp";
import { ApiFault } from "./errors.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export type AssetKind = "avatar" | "banner";
export interface UploadFile { staging_key: string; content_type: string; byte_size: number }

export class AssetStorage {
  private readonly client: S3Client;
  private processing = 0;
  private readonly bucket: string;
  private readonly stagingBucket: string;
  private readonly publicBase: string;
  constructor() {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const bucket = process.env.S3_ASSET_BUCKET;
    const stagingBucket = process.env.S3_UPLOAD_BUCKET;
    const publicBase = process.env.ASSET_PUBLIC_BASE_URL;
    if (!region || !bucket || !stagingBucket || !publicBase) {
      throw new ApiFault(503, "asset_storage_unconfigured", "AWS S3 upload storage is not configured");
    }
    let base: URL;
    try { base = new URL(publicBase); } catch { throw new ApiFault(503, "asset_storage_unconfigured", "Invalid asset delivery URL"); }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || bucket === stagingBucket) {
      throw new ApiFault(503, "asset_storage_unconfigured", "Use separate staging/processed buckets and an HTTPS delivery URL");
    }
    this.bucket = bucket; this.stagingBucket = stagingBucket; this.publicBase = base.href.replace(/\/$/, "");
    this.client = new S3Client({ region, maxAttempts: 2, requestChecksumCalculation: "WHEN_REQUIRED" });
  }
  async sign(file: UploadFile) {
    try {
      return await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.stagingBucket, Key: file.staging_key,
        ContentType: file.content_type, ContentLength: file.byte_size }),
      { expiresIn: 300, signableHeaders: new Set(["content-type", "content-length"]) });
    } catch { throw new ApiFault(503, "asset_storage_unavailable", "Unable to prepare image upload"); }
  }
  async publish(file: UploadFile, kind: AssetKind, captainId: string, uploadId: string): Promise<string> {
    if (this.processing >= 4) throw new ApiFault(503, "image_processing_busy", "Retry image completion shortly");
    this.processing++;
    try { return await this.publishImage(file, kind, captainId, uploadId); }
    finally { this.processing--; }
  }
  private async publishImage(file: UploadFile, kind: AssetKind, captainId: string, uploadId: string): Promise<string> {
    let bytes: Buffer;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.stagingBucket, Key: file.staging_key }), { abortSignal: AbortSignal.timeout(10_000) });
      if (head.ContentLength !== file.byte_size || head.ContentLength > MAX_IMAGE_BYTES || head.ContentType !== file.content_type || !head.ETag) {
        throw new ApiFault(400, "invalid_image", "Uploaded file does not match the declared image type and size");
      }
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.stagingBucket, Key: file.staging_key, IfMatch: head.ETag }), { abortSignal: AbortSignal.timeout(10_000) });
      if (!response.Body) throw new ApiFault(400, "invalid_image", "Uploaded image is empty");
      const chunks: Buffer[] = []; let size = 0;
      try {
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES || size > file.byte_size) throw new ApiFault(400, "invalid_image", "Image exceeds its size limit");
          chunks.push(Buffer.from(chunk));
        }
      } finally { if ("destroy" in response.Body && typeof response.Body.destroy === "function") response.Body.destroy(); }
      if (size !== file.byte_size) throw new ApiFault(400, "invalid_image", "Incomplete image upload");
      bytes = Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof ApiFault) throw error;
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404) throw new ApiFault(409, "upload_not_found", "Upload the file before completing it");
      if (status === 412) throw new ApiFault(409, "upload_changed", "File changed during validation; retry completion");
      throw new ApiFault(503, "asset_storage_unavailable", "Unable to read uploaded image");
    }
    let processed: Buffer;
    try {
      const image = sharp(bytes, { limitInputPixels: 16_000_000, animated: false, failOn: "warning" });
      const metadata = await image.metadata();
      const expected: Record<string, string> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
      if (metadata.format !== expected[file.content_type] || (metadata.pages ?? 1) !== 1 ||
          !metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32 || metadata.width > 8192 || metadata.height > 8192) {
        throw new Error("Unsupported image");
      }
      processed = await image.timeout({ seconds: 5 }).rotate().resize(kind === "avatar" ? 512 : 1600, kind === "avatar" ? 512 : 600, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
    } catch { throw new ApiFault(400, "invalid_image", "Use a valid single-frame JPEG, PNG or WebP image within the dimension limits"); }
    const key = `captains/${captainId}/${kind}/${uploadId}.webp`;
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: processed,
        ContentType: "image/webp", CacheControl: "public, max-age=31536000, immutable" }), { abortSignal: AbortSignal.timeout(10_000) });
    } catch { throw new ApiFault(503, "asset_storage_unavailable", "Unable to publish image"); }
    return `${this.publicBase}/${key}`;
  }
  async discard(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.stagingBucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
  }
  close(): void { this.client.destroy(); }
}
