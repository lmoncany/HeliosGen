import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";

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
  const state  = String(data.state ?? data.status ?? "").toLowerCase();

  console.log("[callback] taskId:", taskId, "state:", state);

  if (!taskId) {
    console.log("[callback] could not extract taskId");
    return NextResponse.json({ received: true });
  }

  if (state === "success") {
    const kieUrl = extractUrl(data.resultJson) ?? data.output?.[0] ?? data.output;
    if (kieUrl) {
      // Upload to R2 (async — don't block the 200 response to kie.ai)
      mirrorToR2(kieUrl, "images")
        .then((r2ImageUrl) => {
          jobStore.set(taskId, { status: "done", imageUrl: r2ImageUrl });
          console.log("[callback] saved to R2:", r2ImageUrl);

          // Update Supabase record
          return supabaseAdmin
            .from("generations")
            .update({ status: "done", image_url: r2ImageUrl })
            .eq("task_id", taskId);
        })
        .then(({ error }) => {
          if (error) console.error("[callback] supabase update error:", error.message);
        })
        .catch((err) => {
          // R2 upload failed — fall back to storing the kie.ai URL directly
          console.error("[callback] R2 upload failed, storing kie.ai URL:", err.message);
          jobStore.set(taskId, { status: "done", imageUrl: kieUrl });
          supabaseAdmin
            .from("generations")
            .update({ status: "done", image_url: kieUrl })
            .eq("task_id", taskId)
            .then(({ error: e }) => {
              if (e) console.error("[callback] supabase fallback update error:", e.message);
            });
        });
    } else {
      console.log("[callback] success but no URL found in resultJson");
    }
  } else if (state === "fail" || state === "failed" || state === "error") {
    const error = data.failMsg ?? data.error ?? body.msg ?? "Generation failed";
    jobStore.set(taskId, { status: "error", error });

    supabaseAdmin
      .from("generations")
      .update({ status: "error", error_msg: error })
      .eq("task_id", taskId)
      .then(({ error: e }) => {
        if (e) console.error("[callback] supabase error update failed:", e.message);
      });
  } else {
    console.log("[callback] intermediate state, ignoring:", state);
  }

  return NextResponse.json({ received: true });
}
