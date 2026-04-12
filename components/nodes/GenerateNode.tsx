"use client";
import { useCallback, useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { resolveInputs } from "@/lib/executor";

type GenerateNodeType = Node<NodeData, "generateNode">;

// ── Models ────────────────────────────────────────────────────────────────────

const MODELS = [
  { id: "nano-banana-2", name: "Nano Banana 2", meta: "Google" },
  { id: "z-image",       name: "Z-Image",       meta: "Z-AI"  },
];

// ── Per-model capabilities ────────────────────────────────────────────────────

const MODEL_CAPS: Record<string, { supportsImages: boolean; supportsQuality: boolean; ratios: string[] }> = {
  "nano-banana-2": {
    supportsImages:  true,
    supportsQuality: true,
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2", "21:9"],
  },
  "z-image": {
    supportsImages:  false,
    supportsQuality: false,
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
  },
};

const DEFAULT_CAPS = MODEL_CAPS["nano-banana-2"];

// ── Aspect ratios ─────────────────────────────────────────────────────────────

// (each model defines its own subset — see MODEL_CAPS above)

function ratioRect(value: string) {
  const [w, h] = value.split(":").map(Number);
  const maxW = 20, maxH = 14;
  const scale = Math.min(maxW / w, maxH / h);
  const rw = Math.round(w * scale);
  const rh = Math.round(h * scale);
  return { rw, rh, x: Math.round((maxW - rw) / 2), y: Math.round((maxH - rh) / 2) };
}

// ── Status dot ────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  idle:    "bg-[#2a2a2a]",
  running: "bg-amber-400 animate-pulse",
  done:    "bg-emerald-500",
  error:   "bg-red-500",
};

// ── Component ────────────────────────────────────────────────────────────────

export default function GenerateNode({ id, data }: NodeProps<GenerateNodeType>) {
  const updateNodeData       = useWorkflowStore((s) => s.updateNodeData);
  const removeEdgesForHandle = useWorkflowStore((s) => s.removeEdgesForHandle);
  const nodes                = useWorkflowStore((s) => s.nodes);
  const edges                = useWorkflowStore((s) => s.edges);

  const [modelOpen, setModelOpen]     = useState(false);
  const [ratioOpen, setRatioOpen]     = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [loading, setLoading]         = useState(false);

  const model       = (data.model as string) ?? "nano-banana-2";
  const caps        = MODEL_CAPS[model] ?? DEFAULT_CAPS;
  const modelInfo   = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const quality     = (data.quality as string) ?? "1k";
  const status      = data.status ?? "idle";

  // If current ratio isn't valid for this model, fall back to 1:1
  const rawRatio  = (data.aspectRatio as string) ?? "1:1";
  const aspectRatio = caps.ratios.includes(rawRatio) ? rawRatio : "1:1";

  const [rw, rh] = aspectRatio.split(":").map(Number);
  const cssRatio = `${rw} / ${rh}`;
  const busy     = loading || status === "running";

  const closeDropdowns = () => {
    setModelOpen(false);
    setRatioOpen(false);
    setQualityOpen(false);
  };

  // ── Poll /api/job-status while a taskId is pending ──────────────────────────
  useEffect(() => {
    const taskId = data.taskId as string | undefined;
    if (!taskId || status !== "running") return;

    let cancelled = false;

    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`/api/job-status?taskId=${taskId}`);
        const json = await res.json();
        if (cancelled) return;

        if (json.status === "done") {
          updateNodeData(id, { status: "done", imageUrl: json.imageUrl, taskId: undefined });
          clearInterval(interval);
        } else if (json.status === "error") {
          updateNodeData(id, { status: "error", errorMsg: json.error, taskId: undefined });
          clearInterval(interval);
        } else if (json.status === "not_found") {
          // Server restarted and lost the job — mark as error
          updateNodeData(id, { status: "error", errorMsg: "Job lost (server restarted)", taskId: undefined });
          clearInterval(interval);
        }
        // "pending" → keep polling
      } catch {
        // network hiccup — keep polling
      }
    }, 3000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [data.taskId, status, id, updateNodeData]);

  // ── Submit generation job ────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    const upstream  = resolveInputs(id, nodes as Node<NodeData>[], edges);
    const prompt    = upstream.prompt;
    const imageUrls = upstream.imageUrls;

    setLoading(true);
    updateNodeData(id, { status: "running", imageUrl: undefined, errorMsg: undefined, taskId: undefined });
    try {
      const res  = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, imageUrls, aspectRatio, quality }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      // Store taskId — the useEffect above will poll until done
      updateNodeData(id, { taskId: json.taskId });
    } catch (e: unknown) {
      updateNodeData(id, { status: "error", errorMsg: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, nodes, edges, model, aspectRatio, quality, updateNodeData]);

  return (
    <div
      className="relative"
      style={{ width: 280 }}
      onMouseLeave={closeDropdowns}
    >
      {/* Floating label */}
      <span className="node-above-label">Image Generator</span>

      <div className="node-card">
        {/* ── Handles ───────────────────────────────────────────────────── */}
        <Handle
          type="target"
          position={Position.Left}
          id="prompt"
          style={{ top: "36%" }}
          className="node-handle node-handle-prompt"
        />
        {caps.supportsImages && (
          <Handle
            type="target"
            position={Position.Left}
            id="image"
            style={{ top: "72%" }}
            className="node-handle node-handle-image"
          />
        )}
        <Handle type="source" position={Position.Right} className="node-handle node-handle-source" />

        {/* ── Image area — top corners clip to card border-radius ───────── */}
        <div
          className="relative bg-[#0d0d0d] overflow-hidden rounded-t-[7px]"
          style={{ aspectRatio: cssRatio }}
        >
          {data.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.imageUrl as string}
              alt="Generated"
              className="w-full h-full object-cover block"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              {status === "error" && (
                <p className="text-red-800 text-[10px] px-4 text-center leading-5">
                  {(data.errorMsg as string) ?? "Generation failed"}
                </p>
              )}
            </div>
          )}

          {/* Loading overlay */}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Spinner />
            </div>
          )}
        </div>

        {/* ── Control bar ─────────────────────────────────────────────────
             Lives outside the image area — dropdowns open freely.          */}
        <div className="flex items-center gap-2 px-2.5 py-[7px] border-t border-[#252525]">
          {/* Status dot */}
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[status]}`} />

          {/* Model dropdown */}
          <div className="relative flex-1 min-w-0">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => { setModelOpen((o) => !o); setRatioOpen(false); setQualityOpen(false); }}
              className="flex items-center gap-1 w-full text-left"
            >
              <span className="text-[11px] text-[#888] hover:text-[#ccc] transition-colors truncate">
                {modelInfo.name}
              </span>
              <ChevronIcon open={modelOpen} />
            </button>

            {modelOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-44 bg-[#141414] border border-[#2a2a2a] rounded-md overflow-hidden z-50 shadow-2xl">
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      const newCaps    = MODEL_CAPS[m.id] ?? DEFAULT_CAPS;
                      const validRatio = newCaps.ratios.includes(aspectRatio) ? aspectRatio : "1:1";
                      updateNodeData(id, { model: m.id, aspectRatio: validRatio });
                      // Unlink any attached images if the new model doesn't support them
                      if (!newCaps.supportsImages) removeEdgesForHandle(id, "image");
                      setModelOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-[7px] text-[11px] hover:bg-[#1e1e1e] transition-colors ${
                      model === m.id ? "text-white" : "text-[#666]"
                    }`}
                  >
                    <span>{m.name}</span>
                    <span className="text-[#383838]">{m.meta}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Divider */}
          <span className="w-px h-3 bg-[#282828] shrink-0" />

          {/* Aspect ratio dropdown */}
          <div className="relative shrink-0">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => { setRatioOpen((o) => !o); setModelOpen(false); setQualityOpen(false); }}
              className="flex items-center gap-1"
            >
              <span className="text-[11px] text-[#888] hover:text-[#ccc] transition-colors tabular-nums">
                {aspectRatio}
              </span>
              <ChevronIcon open={ratioOpen} />
            </button>

            {ratioOpen && (
              <div className="absolute bottom-full right-0 mb-2 w-32 bg-[#141414] border border-[#2a2a2a] rounded-md overflow-hidden z-50 shadow-2xl">
                {caps.ratios.map((r) => {
                  const { rw: iw, rh: ih, x, y } = ratioRect(r);
                  const active = r === aspectRatio;
                  return (
                    <button
                      key={r}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => { updateNodeData(id, { aspectRatio: r }); setRatioOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-[7px] text-[11px] hover:bg-[#1e1e1e] transition-colors ${
                        active ? "text-white" : "text-[#666]"
                      }`}
                    >
                      <svg width="20" height="14" viewBox="0 0 20 14" className="shrink-0">
                        <rect
                          x={x} y={y} width={iw} height={ih} rx="1"
                          fill={active ? "#d4d4d4" : "none"}
                          stroke={active ? "#d4d4d4" : "#444"}
                          strokeWidth="1"
                        />
                      </svg>
                      <span className="tabular-nums">{r}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {caps.supportsQuality && (
            <>
              {/* Divider */}
              <span className="w-px h-3 bg-[#282828] shrink-0" />

              {/* Quality dropdown */}
              <div className="relative shrink-0">
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => { setQualityOpen((o) => !o); setModelOpen(false); setRatioOpen(false); }}
                  className="flex items-center gap-1"
                >
                  <span className="text-[11px] text-[#888] hover:text-[#ccc] transition-colors uppercase">
                    {quality}
                  </span>
                  <ChevronIcon open={qualityOpen} />
                </button>

                {qualityOpen && (
                  <div className="absolute bottom-full right-0 mb-2 w-36 bg-[#141414] border border-[#2a2a2a] rounded-md overflow-hidden z-50 shadow-2xl">
                    {[
                      { id: "1k", label: "1K", meta: "Standard" },
                      { id: "2k", label: "2K", meta: "High" },
                      { id: "4k", label: "4K", meta: "Maximum" },
                    ].map((q) => (
                      <button
                        key={q.id}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => { updateNodeData(id, { quality: q.id }); setQualityOpen(false); }}
                        className={`w-full flex items-center justify-between px-3 py-[7px] text-[11px] hover:bg-[#1e1e1e] transition-colors ${
                          quality === q.id ? "text-white" : "text-[#666]"
                        }`}
                      >
                        <span className="uppercase font-medium">{q.label}</span>
                        <span className="text-[#383838]">{q.meta}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Divider */}
          <span className="w-px h-3 bg-[#282828] shrink-0" />

          {/* Generate button */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={generate}
            disabled={busy}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full border border-[#2a2a2a] hover:border-[#555] text-[#666] hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {busy ? (
              <Spinner size="sm" />
            ) : (
              <svg width="7" height="8" viewBox="0 0 7 8" fill="currentColor">
                <path d="M6.5 3.634a.5.5 0 0 1 0 .732L1 7.83A.5.5 0 0 1 .25 7.464V.536A.5.5 0 0 1 1 .17l5.5 3.464Z"/>
              </svg>
            )}
          </button>

        </div>
      </div>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="8" height="8" viewBox="0 0 8 8" fill="none"
      stroke="#3a3a3a" strokeWidth="1.5" strokeLinecap="round"
      className={`shrink-0 transition-transform duration-100 ${open ? "rotate-180" : ""}`}
    >
      <path d="M1 2.5 4 5.5 7 2.5"/>
    </svg>
  );
}

function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  const cls = size === "sm" ? "w-2.5 h-2.5" : "w-5 h-5";
  return (
    <span className={`${cls} border border-[#444] border-t-[#999] rounded-full animate-spin inline-block`} />
  );
}
