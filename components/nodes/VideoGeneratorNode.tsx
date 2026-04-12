"use client";
import { useCallback, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { resolveInputs } from "@/lib/executor";

type VideoGeneratorNodeType = Node<NodeData, "videoGeneratorNode">;

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
const DURATIONS     = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

// Handle definitions — drives both rendering and tooltip display
const HANDLE_DEFS = [
  { id: "prompt",     label: "Text prompt",              topPct: 26, className: "node-handle-icon node-handle-icon-prompt"   },
  { id: "startFrame", label: "Start frame",              topPct: 44, className: "node-handle-icon node-handle-icon-image"    },
  { id: "endFrame",   label: "End frame",                topPct: 60, className: "node-handle-icon node-handle-icon-image"    },
  { id: "resource",   label: "Reference images (up to 3)", topPct: 77, className: "node-handle-icon node-handle-icon-resource" },
] as const;

// Border colors per handle (for tooltip accent)
const HANDLE_COLORS: Record<string, string> = {
  prompt:     "#77E544",
  startFrame: "#818cf8",
  endFrame:   "#818cf8",
  resource:   "#fb923c",
};

type HandleId = (typeof HANDLE_DEFS)[number]["id"];

const STATUS_DOT: Record<string, string> = {
  idle:    "bg-[#1E1E1E]",
  running: "bg-amber-400 animate-pulse",
  done:    "bg-[#34d399]",
  error:   "bg-red-500",
};

export default function VideoGeneratorNode({ id, data }: NodeProps<VideoGeneratorNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const nodes          = useWorkflowStore((s) => s.nodes);
  const edges          = useWorkflowStore((s) => s.edges);
  const debugMode      = useWorkflowStore((s) => s.debugMode);

  const [loading,     setLoading]     = useState(false);
  const [hoveredHand, setHoveredHand] = useState<HandleId | null>(null);
  const [ratioOpen,   setRatioOpen]   = useState(false);
  const [durOpen,     setDurOpen]     = useState(false);
  const [modeOpen,    setModeOpen]    = useState(false);

  const klingMode   = (data.klingMode   as string)  ?? "pro";
  const duration    = (data.duration    as number)  ?? 5;
  const aspectRatio = (data.aspectRatio as string)  ?? "16:9";
  const sound  = (data.sound  as boolean) ?? false;
  const status = (data.status as string)  ?? "idle";
  const prompt      = (data.prompt      as string)  ?? "";
  const busy        = loading || status === "running";

  const closeAll = () => { setRatioOpen(false); setDurOpen(false); setModeOpen(false); };

  // Connected text node indicator
  const textEdge = edges.find((e) => e.target === id && e.targetHandle === "prompt");
  const textNode = textEdge ? nodes.find((n) => n.id === textEdge.source) : undefined;

  // ── Generate ──────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    const upstream    = resolveInputs(id, nodes as Node<NodeData>[], edges);
    const finalPrompt = upstream.prompt ?? prompt;

    if (!finalPrompt.trim()) {
      if (textEdge) updateNodeData(textEdge.source, { hasError: true });
      return;
    }

    const payload = {
      prompt:       finalPrompt,
      startFrameUrl: upstream.startFrameUrl,
      endFrameUrl:   upstream.endFrameUrl,
      resources:     upstream.resources,
      sound, duration, aspectRatio,
      mode: klingMode,
    };

    if (debugMode) {
      console.log(`[DEBUG] videoNode=${id}`, payload);
      return;
    }

    setLoading(true);
    updateNodeData(id, { status: "running", videoUrl: undefined, errorMsg: undefined });

    try {
      const res  = await fetch("/api/generate-video", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      updateNodeData(id, { status: "done", videoUrl: json.videoUrl });
    } catch (e: unknown) {
      updateNodeData(id, {
        status:   "error",
        errorMsg: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [id, nodes, edges, prompt, sound, duration, aspectRatio, klingMode, debugMode, textEdge, updateNodeData]);

  // Tooltip data
  const hoveredDef = hoveredHand ? HANDLE_DEFS.find((h) => h.id === hoveredHand) : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="video-node-card node-card w-full h-full flex flex-col"
      style={{ minWidth: 320, minHeight: 280 }}
      onMouseLeave={closeAll}
    >
      <CornerResizer minWidth={280} minHeight={240} />

      {/* ── Label above card ────────────────────────────────────────── */}
      <span className="node-above-label" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <VideoNodeIcon />
        {data.label as string}
      </span>

      {/* ── Handles with icons ──────────────────────────────────────── */}
      <Handle type="target" position={Position.Left} id="prompt"     style={{ top: `${HANDLE_DEFS[0].topPct}%` }} className={HANDLE_DEFS[0].className} onMouseEnter={() => setHoveredHand("prompt")}     onMouseLeave={() => setHoveredHand(null)}><PromptIcon /></Handle>
      <Handle type="target" position={Position.Left} id="startFrame" style={{ top: `${HANDLE_DEFS[1].topPct}%` }} className={HANDLE_DEFS[1].className} onMouseEnter={() => setHoveredHand("startFrame")} onMouseLeave={() => setHoveredHand(null)}><FrameStartIcon /></Handle>
      <Handle type="target" position={Position.Left} id="endFrame"   style={{ top: `${HANDLE_DEFS[2].topPct}%` }} className={HANDLE_DEFS[2].className} onMouseEnter={() => setHoveredHand("endFrame")}   onMouseLeave={() => setHoveredHand(null)}><FrameEndIcon /></Handle>
      <Handle type="target" position={Position.Left} id="resource"   style={{ top: `${HANDLE_DEFS[3].topPct}%` }} className={HANDLE_DEFS[3].className} onMouseEnter={() => setHoveredHand("resource")}   onMouseLeave={() => setHoveredHand(null)}><ResourceIcon /></Handle>

      {/* Handle tooltip */}
      {hoveredDef && (
        <div
          className="absolute pointer-events-none z-[1001] text-[10px] px-2.5 py-1 rounded-lg whitespace-nowrap shadow-xl"
          style={{
            top:       `${hoveredDef.topPct}%`,
            left:      0,
            transform: "translate(calc(-100% - 34px), -50%)",
            background: "#1A1A1A",
            border:    `1px solid ${HANDLE_COLORS[hoveredDef.id]}33`,
            color:      "#CCCCCC",
          }}
        >
          <span style={{ color: HANDLE_COLORS[hoveredDef.id] }} className="mr-1.5">●</span>
          {hoveredDef.label}
        </div>
      )}

      {/* ── Main content area ───────────────────────────────────────── */}
      <div
        className="relative flex-1 bg-[#090B0D] rounded-t-[7px] overflow-hidden"
        style={{ minHeight: 160 }}
      >
        {data.videoUrl ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={data.videoUrl as string}
            className="w-full h-full object-cover block"
            controls loop playsInline
          />
        ) : (
          <>
            {/* Error message */}
            {status === "error" && (
              <p className="absolute top-3 left-0 right-0 text-center text-[10px] text-red-600 px-4 leading-5">
                {(data.errorMsg as string) ?? "Generation failed"}
              </p>
            )}

            {/* Prompt area — textarea when no text node connected, chip when connected */}
            {textNode ? (
              <div className="absolute bottom-3 left-4 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#77E544] shrink-0" />
                <span className="text-[11px] text-[#555]">{textNode.data.label as string}</span>
              </div>
            ) : (
              <textarea
                className="absolute bottom-0 left-0 right-0 bg-transparent text-[13px] leading-relaxed resize-none outline-none px-4 pt-3 pb-3 z-10 placeholder-[#3A3A3A]"
                style={{ color: "#666", minHeight: 80 }}
                placeholder="Describe the video you want to generate..."
                value={prompt}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
              />
            )}
          </>
        )}

        {/* Busy overlay */}
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 z-20">
            <Spinner />
            <span className="text-[10px] text-[#8D8E89]">Generating…</span>
          </div>
        )}
      </div>

      {/* ── Row 1: model · ratio · duration ────────────────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[#111]">
        {/* Model label — static, Kling 3.0 only */}
        <Pill interactive={false}>
          <span className="text-[11px] text-[#AAAAAA]">Kling 3.0</span>
          <ChevronIcon />
        </Pill>

        {/* Aspect ratio */}
        <div className="relative">
          <Pill onClick={() => { setRatioOpen((o) => !o); setDurOpen(false); setModeOpen(false); }}>
            <AspectIcon ratio={aspectRatio} />
            <span className="text-[11px] text-[#AAAAAA]">{aspectRatio}</span>
            <ChevronIcon open={ratioOpen} />
          </Pill>
          {ratioOpen && (
            <FloatMenu>
              {ASPECT_RATIOS.map((r) => (
                <FloatItem
                  key={r}
                  active={aspectRatio === r}
                  onClick={() => { updateNodeData(id, { aspectRatio: r }); setRatioOpen(false); }}
                >
                  {r}
                </FloatItem>
              ))}
            </FloatMenu>
          )}
        </div>

        {/* Duration — flex-1 so it stretches to fill remaining width */}
        <div className="relative flex-1">
          <Pill
            onClick={() => { setDurOpen((o) => !o); setRatioOpen(false); setModeOpen(false); }}
            fullWidth
          >
            <span className="text-[11px] text-[#AAAAAA] tabular-nums">{duration}s</span>
            <ChevronIcon open={durOpen} />
          </Pill>
          {durOpen && (
            <FloatMenu fullWidth>
              {DURATIONS.map((d) => (
                <FloatItem
                  key={d}
                  active={duration === d}
                  onClick={() => { updateNodeData(id, { duration: d }); setDurOpen(false); }}
                >
                  {d}s
                </FloatItem>
              ))}
            </FloatMenu>
          )}
        </div>
      </div>

      {/* ── Row 2: resolution · sound · gear · generate ─────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[#111]">
        {/* Resolution */}
        <div className="relative">
          <Pill onClick={() => { setModeOpen((o) => !o); setRatioOpen(false); setDurOpen(false); }}>
            <span className="text-[11px] text-[#AAAAAA]">{klingMode === "pro" ? "1080p" : "720p"}</span>
            <ChevronIcon open={modeOpen} />
          </Pill>
          {modeOpen && (
            <FloatMenu>
              {(["std", "pro"] as const).map((m) => (
                <FloatItem
                  key={m}
                  active={klingMode === m}
                  onClick={() => { updateNodeData(id, { klingMode: m }); setModeOpen(false); }}
                >
                  {m === "std" ? "720p" : "1080p"}
                </FloatItem>
              ))}
            </FloatMenu>
          )}
        </div>

        {/* Sound toggle */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => updateNodeData(id, { sound: !sound })}
          className="flex items-center gap-2 rounded-full px-2.5 py-1.5 transition-colors"
          style={{ background: "#111317" }}
        >
          <ToggleSwitch on={sound} />
          <span className="text-[11px] text-[#AAAAAA]">Sound</span>
        </button>

        {/* Gear */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          className="w-6 h-6 flex items-center justify-center rounded-full text-[#444] hover:text-[#888] transition-colors"
          style={{ background: "#111317" }}
        >
          <GearIcon />
        </button>

        {/* Status dot + spacer */}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-auto ${STATUS_DOT[status]}`} />

        {/* Generate button */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={generate}
          disabled={busy}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white hover:bg-[#E8E8E8] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          {busy ? (
            <Spinner size="sm" dark />
          ) : (
            <svg width="9" height="10" viewBox="0 0 9 10" fill="#0A0C0E">
              <path d="M8.5 4.634a.5.5 0 0 1 0 .732l-7.5 4.5A.5.5 0 0 1 .25 9.5v-9A.5.5 0 0 1 1 .17l7.5 4.464Z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Pill({
  children,
  onClick,
  interactive = true,
  fullWidth   = false,
}: {
  children:     React.ReactNode;
  onClick?:     () => void;
  interactive?: boolean;
  fullWidth?:   boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onMouseDown={onClick ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 ${
        fullWidth ? "w-full justify-between" : ""
      } ${
        interactive && onClick ? "hover:brightness-125 transition-all cursor-pointer" : ""
      }`}
      style={{ background: "#111317" }}
    >
      {children}
    </Tag>
  );
}

function FloatMenu({ children, fullWidth = false }: { children: React.ReactNode; fullWidth?: boolean }) {
  return (
    <div className={`absolute bottom-full left-0 mb-1.5 bg-[#0F1214] border border-[#222] rounded-xl overflow-hidden z-50 shadow-2xl ${fullWidth ? "w-full" : "min-w-max"}`}>
      {children}
    </div>
  );
}

function FloatItem({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={`w-full px-3 py-2 text-left text-[11px] hover:bg-[#161A1E] transition-colors ${
        active ? "text-white font-medium" : "text-[#8D8E89]"
      }`}
    >
      {children}
    </button>
  );
}

function AspectIcon({ ratio }: { ratio: string }) {
  const [w, h] =
    ratio === "16:9" ? [11, 7] : ratio === "9:16" ? [7, 11] : [9, 9];
  return (
    <svg
      width={w} height={h}
      viewBox={`0 0 ${w} ${h}`}
      fill="none"
      stroke="#666"
      strokeWidth="1.2"
    >
      <rect x="0.6" y="0.6" width={w - 1.2} height={h - 1.2} rx="0.8" />
    </svg>
  );
}

function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      width="7" height="7" viewBox="0 0 8 8" fill="none"
      stroke="#555" strokeWidth="1.5" strokeLinecap="round"
      className={`shrink-0 transition-transform duration-100 ${open ? "rotate-180" : ""}`}
    >
      <path d="M1 2.5 4 5.5 7 2.5" />
    </svg>
  );
}

function ToggleSwitch({ on }: { on: boolean }) {
  return (
    <div
      className="relative shrink-0 rounded-full transition-colors"
      style={{
        width:      32,
        height:     18,
        background: on ? "rgba(119,229,68,0.25)" : "#2A2A2A",
      }}
    >
      <div
        className="absolute top-[3px] rounded-full transition-transform"
        style={{
          width:      12,
          height:     12,
          background: on ? "#77E544" : "#555",
          transform:  on ? "translateX(17px)" : "translateX(3px)",
        }}
      />
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function Spinner({ size = "md", dark = false }: { size?: "sm" | "md"; dark?: boolean }) {
  const cls = size === "sm" ? "w-3 h-3" : "w-5 h-5";
  return (
    <span
      className={`${cls} rounded-full animate-spin inline-block`}
      style={{
        border:    `1.5px solid ${dark ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.15)"}`,
        borderTop: dark ? "1.5px solid #0A0C0E" : "1.5px solid #77E544",
      }}
    />
  );
}

function VideoNodeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="m16 10-4-2.5v5L16 10z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ── Handle icons ──────────────────────────────────────────────────────────────

function PromptIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="white">
      <path d="M2 2h12v2.5H9.5V14h-3V4.5H2V2z" />
    </svg>
  );
}

function FrameStartIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M4.5 6h5M7 4l2.5 2L7 8" />
    </svg>
  );
}

function FrameEndIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M9.5 6h-5M7 4 4.5 6 7 8" />
    </svg>
  );
}

function ResourceIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="8" r="2.5" />
      <circle cx="11" cy="4" r="2.5" />
      <circle cx="11" cy="12" r="2.5" />
      <path d="M7.4 6.9 8.6 5.1M7.4 9.1l1.2 1.8" />
    </svg>
  );
}
