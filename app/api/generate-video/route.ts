import { NextRequest, NextResponse } from "next/server";

const KIE_BASE = "https://api.kie.ai";

interface Resource {
  url: string;
  label: string;
}

function extractVideoUrl(resultJson?: string): string | undefined {
  if (!resultJson) return undefined;
  try {
    const parsed = JSON.parse(resultJson);
    const urls = parsed.resultUrls ?? parsed.resultUrl ?? parsed.videoUrl;
    return Array.isArray(urls) ? urls[0] : urls;
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  const {
    prompt,
    startFrameUrl,
    endFrameUrl,
    resources    = [] as Resource[],
    sound        = false,
    duration     = 5,
    aspectRatio  = "16:9",
    mode         = "pro",
  } = await req.json();

  const apiKey = process.env.KIE_API_TOKEN;
  if (!apiKey) {
    return NextResponse.json({ error: "KIE_API_TOKEN not set" }, { status: 500 });
  }

  // Build image_urls array (first frame, then last frame)
  const image_urls: string[] = [];
  if (startFrameUrl) image_urls.push(startFrameUrl);
  if (endFrameUrl)   image_urls.push(endFrameUrl);

  // Build kling_elements from resource connections
  // Each resource image is passed as an element with the URL repeated twice (Kling requires min 2 URLs)
  const kling_elements = (resources as Resource[]).slice(0, 3).map((r) => {
    const safeName = r.label
      .toLowerCase()
      .replace(/\s+#/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      || "element";
    return {
      name:               safeName,
      description:        r.label,
      element_input_urls: [r.url, r.url],
    };
  });

  const input: Record<string, unknown> = {
    prompt:       prompt ?? "",
    sound:        Boolean(sound),
    duration:     String(Math.max(3, Math.min(15, Number(duration)))),
    aspect_ratio: aspectRatio,
    mode,
    multi_shots:  false,
  };

  if (image_urls.length > 0)     input.image_urls     = image_urls;
  if (kling_elements.length > 0) input.kling_elements = kling_elements;

  // Submit task
  const createRes = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "kling-3.0/video", input }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    return NextResponse.json({ error: err }, { status: 500 });
  }

  const created = await createRes.json();
  if (created.code !== 200) {
    return NextResponse.json({ error: created.msg ?? "Task creation failed" }, { status: 500 });
  }

  const taskId = created.data?.taskId;
  if (!taskId) {
    return NextResponse.json({ error: "No taskId returned" }, { status: 500 });
  }

  // Poll recordInfo — up to 5 min (60 × 5 s)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    const poll = await fetch(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );

    if (!poll.ok) continue;

    const data = await poll.json();
    if (data.code !== 200) continue;

    const state = String(data.data?.state ?? "").toLowerCase();

    if (state === "success") {
      const videoUrl = extractVideoUrl(data.data?.resultJson);
      if (videoUrl) return NextResponse.json({ videoUrl });
      return NextResponse.json({ error: "Generation succeeded but no video URL found" }, { status: 500 });
    }

    if (state === "fail") {
      return NextResponse.json(
        { error: data.data?.failMsg ?? "Generation failed" },
        { status: 500 },
      );
    }
    // waiting / queuing / generating → keep polling
  }

  return NextResponse.json({ error: "Timed out after 5 minutes" }, { status: 504 });
}
