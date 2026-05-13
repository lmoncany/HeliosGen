import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import https from "node:https";
import http  from "node:http";
import { hashBuffer, lookupAssetHash, storeAssetHash } from "./assetCache";

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
  const hash = hashBuffer(buffer);
  const cached = await lookupAssetHash(hash);
  if (cached) return cached;

  const key = `${folder}/${randomUUID()}.${ext(contentType)}`;
  const url = cdnUrl(key);

  await getS3().send(
    new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME!,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
    })
  );

  // Store hash and wait for it
  try {
    await storeAssetHash(hash, url, contentType, buffer.byteLength);
  } catch (err) {
    console.error("[r2] Failed to store asset hash:", err);
  }

  return url;
}

/** Fetch a remote URL to a Buffer using Node.js core (immune to Next.js AbortSignal patching). */
function fetchToBuffer(url: string, maxRedirects = 5): Promise<{ buf: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const u   = new URL(url);
    const mod = u.protocol === "https:" ? https : (http as unknown as typeof https);
    mod.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchToBuffer(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks: Buffer[] = [];
      res.on("data",  (c: Buffer) => chunks.push(c));
      res.on("end",   () => resolve({ buf: Buffer.concat(chunks), contentType: res.headers["content-type"] ?? "image/jpeg" }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Fetch a remote URL, upload to R2, return CDN URL. */
export async function mirrorToR2(sourceUrl: string, folder: string): Promise<string> {
  const { buf, contentType } = await fetchToBuffer(sourceUrl);
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
