import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";

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
      const imageUrl = extractUrl(d.data?.resultJson);
      if (imageUrl) jobStore.set(taskId, { status: "done", imageUrl });
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
