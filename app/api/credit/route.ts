import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.KIE_API_TOKEN;
  if (!apiKey) return NextResponse.json({ error: "KIE_API_TOKEN not set" }, { status: 500 });

  const res = await fetch("https://api.kie.ai/api/v1/chat/credit", {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 60 },
  });

  if (!res.ok) return NextResponse.json({ error: "Failed to fetch credit" }, { status: res.status });

  const data = await res.json();
  return NextResponse.json(data);
}
