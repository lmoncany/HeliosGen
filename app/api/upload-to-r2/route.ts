import { NextRequest, NextResponse } from "next/server";
import { uploadDataUrl, mirrorToR2 } from "@/lib/r2";

/**
 * POST { dataUrl: string, folder?: string }
 *   → uploads a base64 data URL or remote URL to R2
 *   → returns { cdnUrl: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { dataUrl, folder = "references" } = await req.json() as {
      dataUrl: string;
      folder?: string;
    };

    if (!dataUrl) {
      return NextResponse.json({ error: "dataUrl is required" }, { status: 400 });
    }

    let cdnUrl: string;
    if (dataUrl.startsWith("data:")) {
      cdnUrl = await uploadDataUrl(dataUrl, folder);
    } else if (dataUrl.startsWith("http")) {
      cdnUrl = await mirrorToR2(dataUrl, folder);
    } else {
      return NextResponse.json({ error: "dataUrl must be a data: or http: URL" }, { status: 400 });
    }

    return NextResponse.json({ cdnUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
