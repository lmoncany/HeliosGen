import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";

const RECORD_INFO = "https://api.kie.ai/api/v1/jobs/recordInfo";

// Parse resultJson string → first URL
function extractUrl(resultJson?: string): string | undefined {
  if (!resultJson) return undefined;
  try {
    const parsed = JSON.parse(resultJson);
    const urls = parsed.resultUrls ?? parsed.resultUrl;
    return Array.isArray(urls) ? urls[0] : urls;
  } catch {
    return undefined;
  }
}

// If callback was missed, poll kie.ai directly and update the store
async function syncFromKie(taskId: string, token: string): Promise<void> {
  try {
    const r = await fetch(`${RECORD_INFO}?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const d = await r.json();
    if (d.code !== 200) return;

    const state = String(d.data?.state ?? "").toLowerCase();

    if (state === "success") {
      const kieUrl = extractUrl(d.data?.resultJson);
      if (kieUrl) {
        const existing = jobStore.get(taskId);
        const isVideo = existing?.status === "pending" && (existing as { type?: string }).type === "video";
        const folder  = isVideo ? "videos" : "images";

        let r2Url = kieUrl;
        try {
          r2Url = await mirrorToR2(kieUrl, folder);
        } catch (err) {
          console.error("[job-status] R2 mirror failed, using kie.ai URL:", err);
        }

        if (isVideo) {
          jobStore.set(taskId, { status: "done", videoUrl: r2Url });
          supabaseAdmin.from("generations").update({ status: "done", video_url: r2Url }).eq("task_id", taskId)
            .then(({ error }) => { if (error) console.error("[job-status] supabase update error:", error.message); });
        } else {
          jobStore.set(taskId, { status: "done", imageUrl: r2Url });
          supabaseAdmin.from("generations").update({ status: "done", image_url: r2Url }).eq("task_id", taskId)
            .then(({ error }) => { if (error) console.error("[job-status] supabase update error:", error.message); });
        }
      }
    } else if (state === "fail") {
      jobStore.set(taskId, { status: "error", error: d.data?.failMsg || "Generation failed" });
    }
    // waiting / queuing / generating → leave as pending
  } catch {
    // network error — leave store as-is
  }
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const result = jobStore.get(taskId);
  if (!result) {
    return NextResponse.json({ status: "not_found" });
  }

  // Still pending — check kie.ai directly in case the callback was missed
  if (result.status === "pending") {
    const token = process.env.KIE_API_TOKEN;
    if (token) await syncFromKie(taskId, token);
    return NextResponse.json(jobStore.get(taskId) ?? result);
  }

  return NextResponse.json(result);
}
