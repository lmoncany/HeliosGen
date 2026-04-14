/**
 * POST /api/upload-asset
 *
 * Unified raw-binary upload for images and videos.
 * Body  : raw file bytes
 * Headers:
 *   Content-Type  : MIME type of the file (image/jpeg, video/mp4, …)
 *   Authorization : Bearer <supabase-token>  (optional)
 *
 * Flow:
 *   1. Read body as Buffer
 *   2. Compute SHA-256 hash
 *   3. If hash already in asset_cache → return existing CDN URL (no R2 write)
 *   4. Otherwise upload to R2, store hash, return new CDN URL
 */
import { NextRequest, NextResponse } from "next/server";
import { uploadBuffer } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashBuffer, lookupAssetHash, storeAssetHash } from "@/lib/assetCache";

export const maxDuration = 60;

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

async function getUserId(req: NextRequest): Promise<string | null> {
  const auth  = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user?.id ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const mimeType = req.headers.get("content-type") ?? "application/octet-stream";

    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      return NextResponse.json({ error: "File exceeds 100 MB limit" }, { status: 413 });
    }

    const bytes  = await req.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (buffer.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "File exceeds 100 MB limit" }, { status: 413 });
    }

    // ── Deduplication: check hash before any R2 write ────────────────────────
    const hash = hashBuffer(buffer);
    const cached = await lookupAssetHash(hash);
    if (cached) {
      return NextResponse.json({ cdnUrl: cached, cached: true });
    }

    // ── Upload to R2 ─────────────────────────────────────────────────────────
    const folder  = mimeType.startsWith("video/") ? "references" : "uploads";
    const cdnUrl  = await uploadBuffer(buffer, mimeType, folder);

    // ── Store hash (fire-and-forget) ─────────────────────────────────────────
    storeAssetHash(hash, cdnUrl, mimeType, buffer.byteLength).catch(() => {});

    // ── Record in user_uploads if authenticated ──────────────────────────────
    const userId = await getUserId(req);
    if (userId) {
      supabaseAdmin.from("user_uploads").insert({
        user_id:   userId,
        r2_url:    cdnUrl,
        mime_type: mimeType,
        source:    "user_upload",
      }).then(({ error }) => {
        if (error) console.error("[upload-asset] db insert error:", error.message);
      });
    }

    return NextResponse.json({ cdnUrl, cached: false });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
