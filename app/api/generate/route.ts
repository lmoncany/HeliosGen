import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { ensureR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";

const BASE   = "https://api.kie.ai";
const CREATE = `${BASE}/api/v1/jobs/createTask`;

// Resolve every image URL to an R2 CDN URL (uploads base64 / mirrors external URLs)
async function resolveImages(imageUrls: string[]): Promise<string[]> {
  const resolved = await Promise.all(
    imageUrls.slice(0, 14).map((u) => ensureR2(u, "references").catch(() => null))
  );
  return resolved.filter((u): u is string => u !== null);
}

// Extract user_id from the Authorization header (Bearer <access_token>)
async function getUserId(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user?.id ?? null;
}

export async function POST(req: NextRequest) {
  const {
    model       = "nano-banana-2",
    prompt,
    imageUrls   = [],
    aspectRatio = "1:1",
    quality     = "1k",
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
    // Upload all reference images to R2
    const r2ImageUrls = await resolveImages(imageUrls);

    let requestBody: Record<string, unknown>;

    if (model === "z-image") {
      requestBody = {
        model: "z-image",
        callBackUrl,
        input: {
          prompt:       prompt.slice(0, 1000),
          aspect_ratio: aspectRatio,
          nsfw_checker: true,
        },
      };
    } else {
      const resolution = quality === "4k" ? "4K" : quality === "2k" ? "2K" : "1K";
      requestBody = {
        model: "nano-banana-2",
        callBackUrl,
        input: {
          prompt,
          image_input:  r2ImageUrls,
          aspect_ratio: aspectRatio,
          resolution,
          output_format: "jpg",
        },
      };
    }

    const res = await fetch(CREATE, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify(requestBody),
    });

    if (!res.ok) throw new Error(await res.text());
    const d = await res.json();
    if (d.code !== undefined && d.code !== 200) throw new Error(d.msg ?? `API error ${d.code}`);

    const taskId = d.data?.taskId ?? d.data?.id ?? d.taskId ?? d.id;
    if (!taskId) throw new Error("No task ID in response");

    jobStore.set(taskId, { status: "pending" });

    // Save metadata to Supabase (fire-and-forget — don't block the response)
    const userId = await getUserId(req);
    supabaseAdmin.from("generations").insert({
      task_id:              taskId,
      user_id:              userId,
      generation_type:      "image",
      status:               "pending",
      prompt,
      model,
      aspect_ratio:         aspectRatio,
      quality,
      reference_image_urls: r2ImageUrls,
    }).then(({ error }) => {
      if (error) console.error("[generate] supabase insert error:", error.message);
    });

    return NextResponse.json({ taskId, referenceImageUrls: r2ImageUrls });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
