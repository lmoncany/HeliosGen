import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

let _s3: S3Client | null = null;

function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return _s3;
}

function cdnUrl(key: string): string {
  return `${process.env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;
}

function ext(contentType: string): string {
  if (contentType.includes("mp4"))  return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("png"))  return "png";
  if (contentType.includes("gif"))  return "gif";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

/** Upload a Buffer to R2 and return the public CDN URL. */
export async function uploadBuffer(
  buffer: Buffer,
  contentType: string,
  folder: string
): Promise<string> {
  const key = `${folder}/${randomUUID()}.${ext(contentType)}`;
  await getS3().send(
    new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME!,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
    })
  );
  return cdnUrl(key);
}

/** Fetch a remote URL, upload to R2, return CDN URL. */
export async function mirrorToR2(sourceUrl: string, folder: string): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`mirrorToR2: fetch failed ${res.status} for ${sourceUrl}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return uploadBuffer(buf, contentType, folder);
}

/** Upload a base64 data URL to R2, return CDN URL. */
export async function uploadDataUrl(dataUrl: string, folder: string): Promise<string> {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) throw new Error("uploadDataUrl: not a valid data URL");
  const contentType = m[1];
  const buf = Buffer.from(m[2], "base64");
  return uploadBuffer(buf, contentType, folder);
}

/** Resolve any URL to an R2 CDN URL:
 *  - data: → upload to R2
 *  - http (not already our CDN) → mirror to R2
 *  - already our CDN → return as-is
 */
export async function ensureR2(url: string, folder: string): Promise<string> {
  const cdnBase = process.env.R2_PUBLIC_URL ?? "";
  if (url.startsWith("data:"))        return uploadDataUrl(url, folder);
  if (cdnBase && url.startsWith(cdnBase)) return url;
  return mirrorToR2(url, folder);
}
