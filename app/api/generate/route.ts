import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";

const BASE   = "https://api.kie.ai";
const CREATE = `${BASE}/api/v1/jobs/createTask`;
const UPLOAD = "https://kieai.redpandaai.co/api/file-base64-upload";

// ── Upload a base64 data URL, return an http URL ──────────────────────────────
async function uploadDataUrl(dataUrl: string, token: string): Promise<string> {
  const res = await fetch(UPLOAD, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64Data: dataUrl,
      uploadPath: "images/uploads",
    }),
  });

  if (!res.ok) throw new Error(`Image upload failed: ${await res.text()}`);
  const d = await res.json();
  if (!d.success) throw new Error(d.msg ?? "Upload failed");
  const url = d.data?.downloadUrl;
  if (!url) throw new Error("Upload succeeded but no downloadUrl in response");
  return url;
}

// ── Resolve every image to an http URL ───────────────────────────────────────
async function resolveImages(imageUrls: string[], token: string): Promise<string[]> {
  const resolved = await Promise.all(
    imageUrls.slice(0, 14).map(async (u) => {
      if (u.startsWith("http")) return u;
      if (u.startsWith("data:")) return uploadDataUrl(u, token);
      return null;
    })
  );
  return resolved.filter((u): u is string => u !== null);
}

// ── Route ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const {
    model      = "nano-banana-2",
    prompt,
    imageUrls  = [],
    aspectRatio = "1:1",
    quality    = "1k",
  } = (await req.json()) as {
    model?:       string;
    prompt?:      string;
    imageUrls?:   string[];
    aspectRatio?: string;
    quality?:     string;
  };

  const token = process.env.KIE_API_TOKEN;
  if (!token) return NextResponse.json({ error: "KIE_API_TOKEN is not set" }, { status: 500 });

  const callbackBase = process.env.CALLBACK_BASE_URL;
  if (!callbackBase) return NextResponse.json({ error: "CALLBACK_BASE_URL is not set" }, { status: 500 });

  if (!prompt?.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });

  const callBackUrl = `${callbackBase.replace(/\/$/, "")}/api/callback`;

  try {
    let requestBody: Record<string, unknown>;

    if (model === "z-image") {
      // z-image: text-only, no image_input, no resolution, no output_format
      requestBody = {
        model: "z-image",
        callBackUrl,
        input: {
          prompt: prompt.slice(0, 1000), // max 1000 chars per spec
          aspect_ratio: aspectRatio,
          nsfw_checker: true,
        },
      };
    } else {
      // nano-banana-2 (default): supports image_input + resolution
      const resolution  = quality === "4k" ? "4K" : quality === "2k" ? "2K" : "1K";
      const httpImages  = await resolveImages(imageUrls ?? [], token);
      requestBody = {
        model: "nano-banana-2",
        callBackUrl,
        input: {
          prompt,
          image_input: httpImages,
          aspect_ratio: aspectRatio,
          resolution,
          output_format: "jpg",
        },
      };
    }

    const res = await fetch(CREATE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) throw new Error(await res.text());
    const d = await res.json();

    if (d.code !== undefined && d.code !== 200) {
      throw new Error(d.msg ?? `API error ${d.code}`);
    }

    const taskId = d.data?.taskId ?? d.data?.id ?? d.taskId ?? d.id;
    if (!taskId) throw new Error("No task ID in response");

    jobStore.set(taskId, { status: "pending" });
    return NextResponse.json({ taskId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
