import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { prompt, imageUrl, model = "wan-t2v", duration = 5 } = await req.json();

  const apiKey = process.env.REPLICATE_API_TOKEN;
  if (!apiKey) {
    return NextResponse.json(
      { error: "REPLICATE_API_TOKEN not set" },
      { status: 500 }
    );
  }

  // Model configs
  type ModelConfig = {
    model: string;
    input: Record<string, unknown>;
  };

  const modelConfigs: Record<string, ModelConfig> = {
    // Wan 2.1 text-to-video (no image required)
    "wan-t2v": {
      model: "wavespeedai/wan-2.1-t2v-480p",
      input: { prompt, num_frames: duration * 16 },
    },
    // Wan 2.1 image-to-video
    "wan-i2v": {
      model: "wavespeedai/wan-2.1-i2v-480p",
      input: {
        prompt: prompt || "animate this image",
        image: imageUrl,
        num_frames: duration * 16,
      },
    },
    // Stable Video Diffusion (image-to-video)
    svd: {
      model:
        "stability-ai/stable-video-diffusion:3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438",
      input: {
        input_image: imageUrl,
        video_length: "25_frames_with_svd_xt",
        sizing_strategy: "maintain_aspect_ratio",
        frames_per_second: 6,
        motion_bucket_id: 127,
      },
    },
  };

  const cfg = modelConfigs[model] || modelConfigs["wan-t2v"];

  // Validate: i2v models need an image
  if ((model === "wan-i2v" || model === "svd") && !imageUrl) {
    return NextResponse.json(
      { error: "This model requires an image input. Connect an image generation node first." },
      { status: 400 }
    );
  }

  const body: Record<string, unknown> = { input: cfg.input };
  if (cfg.model.includes(":")) {
    body.version = cfg.model.split(":")[1];
  } else {
    body.model = cfg.model;
  }

  const createRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    return NextResponse.json({ error: err }, { status: 500 });
  }

  const prediction = await createRes.json();

  // Poll
  const id = prediction.id;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await poll.json();
    if (data.status === "succeeded") {
      const output = Array.isArray(data.output) ? data.output[0] : data.output;
      return NextResponse.json({ videoUrl: output });
    }
    if (data.status === "failed") {
      return NextResponse.json({ error: data.error }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Timed out" }, { status: 504 });
}
