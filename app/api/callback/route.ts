import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";

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

export async function POST(req: NextRequest) {
  const body = await req.json();
  console.log("[callback] received:", JSON.stringify(body, null, 2));

  const data   = body.data ?? body;
  const taskId = data.taskId ?? data.id ?? body.taskId ?? body.id;

  // kie.ai uses `state` with values: waiting / queuing / generating / success / fail
  const state  = String(data.state ?? data.status ?? "").toLowerCase();

  console.log("[callback] taskId:", taskId, "state:", state);

  if (taskId) {
    if (state === "success") {
      const imageUrl = extractUrl(data.resultJson) ?? data.output?.[0] ?? data.output;
      if (imageUrl) {
        jobStore.set(taskId, { status: "done", imageUrl });
        console.log("[callback] saved done:", imageUrl);
      } else {
        console.log("[callback] success but no URL found in resultJson");
      }
    } else if (state === "fail" || state === "failed" || state === "error") {
      const error = data.failMsg ?? data.error ?? body.msg ?? "Generation failed";
      jobStore.set(taskId, { status: "error", error });
      console.log("[callback] saved error:", error);
    } else {
      console.log("[callback] intermediate state, ignoring:", state);
    }
  } else {
    console.log("[callback] could not extract taskId from payload");
  }

  return NextResponse.json({ received: true });
}
