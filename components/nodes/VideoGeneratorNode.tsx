"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node, useUpdateNodeInternals } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { resolveInputs } from "@/lib/executor";
import { createClient } from "@/lib/supabase/client";
import { VIDEO_MODELS as VIDEO_MODEL_CFG } from "@/lib/modelConfig";

type VideoGeneratorNodeType = Node<NodeData, "videoGeneratorNode">;

// ── Handles ───────────────────────────────────────────────────────────────────

type HandleDef = { id: string; label: string; topPct: number; className: string };

const KLING_HANDLES: HandleDef[] = [
  { id: "prompt",     label: "Text prompt",               topPct: 26, className: "node-handle-icon node-handle-icon-prompt" },
  { id: "startFrame", label: "Reference image",           topPct: 44, className: "node-handle-icon node-handle-icon-image" },
  { id: "endFrame",   label: "End frame",                 topPct: 60, className: "node-handle-icon node-handle-icon-image" },
  { id: "resource",   label: "Reference images (up to 3)",topPct: 77, className: "node-handle-icon node-handle-icon-resource" },
  { id: "videoRef",   label: "Reference video",           topPct: 77, className: "node-handle-icon node-handle-icon-videoref" },
];

const HANDLE_COLORS: Record<string, string> = {
  prompt:     "#77E544",
  startFrame: "#818cf8",
  endFrame:   "#818cf8",
  resource:   "#fb923c",
  videoRef:   "#22d3ee",
};

const STATUS_DOT: Record<string, string> = {
  idle: "bg-[#1E1E1E]",
  running: "bg-amber-400 animate-pulse",
  done: "bg-[#34d399]",
  error: "bg-red-500",
};

// ── Component ─────────────────────────────────────────────────────────────────


export default function VideoGeneratorNode({ id, data }: NodeProps<VideoGeneratorNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const updateNodeSize = useWorkflowStore((s) => s.updateNodeSize);
  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const killEdgesForHandles = useWorkflowStore((s) => s.killEdgesForHandles);
  const flashEdgeError = useWorkflowStore((s) => s.flashEdgeError);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const debugMode = useWorkflowStore((s) => s.debugMode);

  const updateNodeInternals = useUpdateNodeInternals();
  const cardRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(false);
  const [hoveredHand, setHoveredHand] = useState<string | null>(null);
  const [errorHandles, setErrorHandles] = useState<Set<string>>(new Set());
  const [modelOpen, setModelOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [durOpen, setDurOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [grokResOpen, setGrokResOpen] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ── Data ──────────────────────────────────────────────────────────────────
  const videoModelId = (data.videoModel as string) ?? "kling-3.0";
  const cfg = VIDEO_MODEL_CFG.find((m) => m.id === videoModelId) ?? VIDEO_MODEL_CFG[0];

  const mode = (data.klingMode as string) ?? cfg.defaultMode ?? "";
  const resolution = (data.grokResolution as string) ?? cfg.defaultResolution ?? "";
  const duration = (data.duration as number) ?? cfg.defaultDuration;
  const aspectRatio = (data.aspectRatio as string) ?? cfg.defaultRatio;
  const sound = (data.sound as boolean) ?? false;
  const status = (data.status as string) ?? "idle";
  const prompt = (data.prompt as string) ?? "";
  const busy = loading || status === "running";
  const videoUrl = data.videoUrl as string | undefined;

  // ── Generation history ────────────────────────────────────────────────────
  const generations    = (data.generations as string[] | undefined) ?? (videoUrl ? [videoUrl] : []);
  const currentGenIdx  = Math.min((data.currentGenIdx as number | undefined) ?? Math.max(0, generations.length - 1), Math.max(0, generations.length - 1));
  const generationsRef = useRef(generations);
  generationsRef.current = generations;

  const goToGen = useCallback((idx: number) => {
    const gens = generationsRef.current;
    const clamped = Math.max(0, Math.min(gens.length - 1, idx));
    updateNodeData(id, { currentGenIdx: clamped, videoUrl: gens[clamped], status: "done", errorMsg: undefined });
  }, [id, updateNodeData]);

  const handleVideoMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (!v.videoWidth || !v.videoHeight) return;
    updateNodeData(id, { imageNaturalRatio: `${v.videoWidth} / ${v.videoHeight}` });
    const nodeWidth = cardRef.current?.offsetWidth ?? 320;
    const videoH = nodeWidth * (v.videoHeight / v.videoWidth);
    updateNodeSize(id, nodeWidth, videoH + 76);
  };

  // Re-sync edge anchor positions whenever the node resizes
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (cardRef.current) {
        const { offsetWidth, offsetHeight } = cardRef.current;
        updateNodeSize(id, offsetWidth, offsetHeight);
      }
      updateNodeInternals(id);
    });
    return () => cancelAnimationFrame(raf);
  }, [id, aspectRatio, data.imageNaturalRatio, updateNodeSize, updateNodeInternals]);

  // All 4 handle slots always render at fixed positions so anchors never jump.
  // Handles not in cfg.handles are hidden.
  const handles = KLING_HANDLES;
  const activeHandles = new Set<string>(cfg.handles);
  const ratios = cfg.ratios;
  const durations = cfg.durations;

  const closeAll = () => {
    setModelOpen(false); setRatioOpen(false); setDurOpen(false);
    setModeOpen(false); setGrokResOpen(false);
  };

  const textEdge = edges.find((e) => e.target === id && e.targetHandle === "prompt");
  const textNode = textEdge ? nodes.find((n) => n.id === textEdge.source) : undefined;
  const hasResource = edges.some((e) => e.target === id && e.targetHandle === "resource");

  // ── Generate ──────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    const { data: authData } = await createClient().auth.getSession();
    if (!authData.session) { setAuthModalOpen(true); return; }

    const upstream = resolveInputs(id, nodes as Node<NodeData>[], edges);
    const finalPrompt = upstream.prompt ?? prompt;

    if (!cfg.promptOptional && !finalPrompt.trim()) {
      if (textEdge) {
        updateNodeData(textEdge.source, { hasError: true });
        flashEdgeError(textEdge.id);
      }
      return;
    }

    // ── Motion-control: validate mandatory image + video handles ──────────────
    if (cfg.apiInput.useMotionControl) {
      const imageEdge = edges.find((e) => e.target === id && e.targetHandle === "startFrame");
      const videoEdge = edges.find((e) => e.target === id && e.targetHandle === "videoRef");

      const flashSet = new Set<string>();
      let hasError = false;

      // startFrame: not connected → flash handle; connected but empty → flash edge + source node
      if (!imageEdge) {
        flashSet.add("startFrame");
        hasError = true;
      } else if (!upstream.startFrameUrl) {
        const srcNode = nodes.find((n) => n.id === imageEdge.source);
        if (srcNode) updateNodeData(srcNode.id, { hasError: true });
        flashEdgeError(imageEdge.id);
        hasError = true;
      }

      // videoRef: not connected → flash handle; connected but empty → flash edge + source node
      if (!videoEdge) {
        flashSet.add("videoRef");
        hasError = true;
      } else if (!upstream.videoRefUrl) {
        const srcNode = nodes.find((n) => n.id === videoEdge.source);
        if (srcNode) updateNodeData(srcNode.id, { hasError: true });
        flashEdgeError(videoEdge.id);
        hasError = true;
      }

      if (flashSet.size > 0) {
        setErrorHandles(flashSet);
        setTimeout(() => setErrorHandles(new Set()), 1400);
      }
      if (hasError) return;
    }

    // Build full payload first so debug log matches what gets sent
    const payload: Record<string, unknown> = {
      videoModel: videoModelId,
      prompt: finalPrompt,
      aspectRatio,
      duration,
      mode,
      resolution,
      sound,
      startFrameUrl:      upstream.startFrameUrl,
      endFrameUrl:        upstream.endFrameUrl,
      videoRefUrl:        upstream.videoRefUrl,
      resources:          upstream.resources,
      referenceImageUrls: upstream.resources.length > 0
        ? upstream.resources.map((r) => r.url)
        : undefined,
    };

    if (debugMode) {
      console.log(`[DEBUG] videoNode=${id}`, payload);
      setLoading(true);
      await new Promise((r) => setTimeout(r, 3000));
      setLoading(false);
      return;
    }

    setLoading(true);
    updateNodeData(id, { status: "running", videoUrl: undefined, imageNaturalRatio: undefined, errorMsg: undefined });

    try {
      const res = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      const newGens = [...generationsRef.current, json.videoUrl as string];
      updateNodeData(id, { status: "done", videoUrl: json.videoUrl, generations: newGens, currentGenIdx: newGens.length - 1 });
    } catch (e: unknown) {
      updateNodeData(id, {
        status: "error",
        errorMsg: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [id, nodes, edges, prompt, sound, duration, aspectRatio, videoModelId,
    mode, resolution, cfg, debugMode, textEdge, updateNodeData, setAuthModalOpen, flashEdgeError]);

  const hoveredDef = hoveredHand && activeHandles.has(hoveredHand)
    ? handles.find((h) => h.id === hoveredHand)
    : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={cardRef}
      className={`video-node-card node-card w-full h-full flex flex-col${(data.hasError as boolean) ? " node-error-blink" : ""}`}
      style={{ minWidth: 320, minHeight: 280, ...(busy ? { animation: "video-node-pulse-glow 2.4s ease-in-out infinite" } : {}) }}
      onMouseLeave={closeAll}
      onAnimationEnd={(e) => { if (e.animationName === "node-error-blink") updateNodeData(id, { hasError: false }); }}
    >
      <CornerResizer minWidth={280} minHeight={80} keepAspectRatio={!!data.videoUrl} />

      <span className="node-above-label" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <VideoNodeIcon />
        {data.label as string}
      </span>

      {/* ── Handles ──────────────────────────────────────────────────── */}
      {handles.map((h) => {
        const hidden = !activeHandles.has(h.id);
        return (
          <Handle
            key={h.id}
            type="target"
            position={Position.Left}
            id={h.id}
            style={{ top: `${h.topPct}%`, visibility: hidden ? "hidden" : "visible", pointerEvents: hidden ? "none" : "auto" }}
            className={`${h.className}${errorHandles.has(h.id) ? " node-handle-error" : ""}`}
            onMouseEnter={() => { if (!hidden) setHoveredHand(h.id); }}
            onMouseLeave={() => setHoveredHand(null)}
          >
            {h.id === "prompt"     && <PromptIcon />}
            {h.id === "startFrame" && <FrameStartIcon />}
            {h.id === "endFrame"   && <FrameEndIcon />}
            {h.id === "resource"   && <ResourceIcon />}
            {h.id === "videoRef"   && <VideoRefIcon />}
          </Handle>
        );
      })}

      {/* Handle tooltip */}
      {hoveredDef && (
        <div
          className="absolute pointer-events-none z-[1001] text-[10px] px-2.5 py-1 rounded-lg whitespace-nowrap shadow-xl"
          style={{
            top: `${hoveredDef.topPct}%`,
            left: 0,
            transform: "translate(calc(-100% - 34px), -50%)",
            background: "#1A1A1A",
            border: `1px solid ${HANDLE_COLORS[hoveredDef.id]}33`,
            color: "#CCCCCC",
          }}
        >
          <span style={{ color: HANDLE_COLORS[hoveredDef.id] }} className="mr-1.5">●</span>
          {hoveredDef.label}
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────── */}
      {videoUrl ? (
        <div
          className="relative bg-[#090B0D] rounded-t-[7px] overflow-hidden group/player group/gen"
          style={{ aspectRatio: (data.imageNaturalRatio as string | undefined) ?? "16 / 9", width: "100%" }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            key={videoUrl}
            src={videoUrl}
            className="w-full h-full block"
            style={{ objectFit: "fill" }}
            autoPlay
            loop
            playsInline
            muted={muted}
            onLoadedMetadata={handleVideoMeta}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              setCurrentSec(v.currentTime);
              if (v.duration) setProgress(v.currentTime / v.duration);
            }}
          />

          {/* Timer badge — top-left, visible on hover */}
          <div className="absolute top-2 left-2 h-7 px-2 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/player:opacity-100 transition-opacity z-10 pointer-events-none">
            <span className="text-[11px] text-white font-mono tabular-nums">{fmtTime(currentSec)}</span>
          </div>

          {/* Mute / unmute button — top-right, visible on hover */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/player:opacity-100 transition-opacity pointer-events-auto z-10"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            )}
          </button>

          {/* Progress bar — bottom, visible on hover */}
          <div
            className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/10 opacity-0 group-hover/player:opacity-100 transition-opacity"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              const v = videoRef.current;
              if (v && v.duration) v.currentTime = pct * v.duration;
            }}
            style={{ cursor: "pointer" }}
          >
            <div
              className="h-full bg-white/70 transition-none"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          {/* ── Carousel ───────────────────────────────────────────────── */}
          {generations.length > 1 && (
            <>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); goToGen(currentGenIdx - 1); }}
                disabled={currentGenIdx === 0}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/gen:opacity-100 transition-opacity disabled:opacity-0 z-10 pointer-events-auto"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); goToGen(currentGenIdx + 1); }}
                disabled={currentGenIdx === generations.length - 1}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/gen:opacity-100 transition-opacity disabled:opacity-0 z-10 pointer-events-auto"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1 z-10" onMouseDown={(e) => e.stopPropagation()}>
                {generations.length <= 8 ? generations.map((_, i) => (
                  <button
                    key={i}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); goToGen(i); }}
                    className={`w-1.5 h-1.5 rounded-full transition-colors pointer-events-auto ${i === currentGenIdx ? "bg-white" : "bg-white/30 hover:bg-white/60"}`}
                  />
                )) : (
                  <span className="text-[10px] text-white/60 font-mono tabular-nums bg-black/30 px-1.5 py-0.5 rounded-full">
                    {currentGenIdx + 1} / {generations.length}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="relative flex-1 bg-[#090B0D] rounded-t-[7px] overflow-hidden group/gen" style={{ minHeight: 160 }}>
          {status === "error" && (
            <div className="absolute inset-0 flex flex-col justify-center px-5 gap-2.5">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="shrink-0 mb-0.5">
                <circle cx="12" cy="12" r="10" fill="#1a0a0a" stroke="#5a1a1a" strokeWidth="1.5" />
                <path d="M12 7v5" stroke="#c04040" strokeWidth="2" strokeLinecap="round" />
                <circle cx="12" cy="16" r="1" fill="#c04040" />
              </svg>
              <p className="text-white text-[12px] font-semibold leading-snug">Oops! Something went wrong.</p>
              <p className="text-[#555] text-[10px] leading-[1.5] break-words">
                {(data.errorMsg as string) ?? "Generation failed"}
              </p>
            </div>
          )}
          {textNode && !status.includes("error") && (
            <div className="absolute bottom-3 left-4 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#77E544] shrink-0" />
              <span className="text-[11px] text-[#555]">{textNode.data.label as string}</span>
            </div>
          )}

          {/* Carousel — shown even on error so user can browse previous generations */}
          {generations.length > 0 && (
            <>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); goToGen(currentGenIdx - 1); }}
                disabled={currentGenIdx === 0}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/gen:opacity-100 transition-opacity disabled:opacity-0 z-10 pointer-events-auto"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); goToGen(currentGenIdx + 1); }}
                disabled={currentGenIdx === generations.length - 1}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/gen:opacity-100 transition-opacity disabled:opacity-0 z-10 pointer-events-auto"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 z-10" onMouseDown={(e) => e.stopPropagation()}>
                {generations.length <= 8 ? generations.map((_, i) => (
                  <button
                    key={i}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); goToGen(i); }}
                    className={`w-1.5 h-1.5 rounded-full transition-colors pointer-events-auto ${i === currentGenIdx ? "bg-white" : "bg-white/30 hover:bg-white/60"}`}
                  />
                )) : (
                  <span className="text-[10px] text-white/60 font-mono tabular-nums bg-black/30 px-1.5 py-0.5 rounded-full">
                    {currentGenIdx + 1} / {generations.length}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Row 1: model · ratio · duration ──────────────────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[#111]">
        {/* Model selector */}
        <div className="relative">
          <Pill onClick={() => { setModelOpen((o) => !o); setRatioOpen(false); setDurOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
            <span className="text-[11px] text-[#AAAAAA]">{cfg.name}</span>
            <ChevronIcon open={modelOpen} />
          </Pill>
          {modelOpen && (
            <FloatMenu>
              {VIDEO_MODEL_CFG.map((m) => (
                <button
                  key={m.id}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    const validRatio = m.ratios.includes(aspectRatio) ? aspectRatio : m.defaultRatio;
                    const validDur = m.durations.includes(duration) ? duration : m.defaultDuration;
                    updateNodeData(id, { videoModel: m.id, aspectRatio: validRatio, duration: validDur });
                    // Kill edges on handles the new model doesn't support
                    const removedHandles = (cfg.handles as string[]).filter(
                      (h) => !(m.handles as string[]).includes(h)
                    );
                    if (removedHandles.length) killEdgesForHandles(id, removedHandles);
                    setModelOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-[11px] hover:bg-[#161A1E] transition-colors ${videoModelId === m.id ? "text-white font-medium" : "text-[#8D8E89]"
                    }`}
                >
                  <span>{m.name}</span>
                  <span className="text-[#4A4A45]">{m.provider}</span>
                </button>
              ))}
            </FloatMenu>
          )}
        </div>

        {/* Aspect ratio */}
        <div className="relative">
          <Pill onClick={() => { setRatioOpen((o) => !o); setModelOpen(false); setDurOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
            <AspectIcon ratio={aspectRatio} />
            <span className="text-[11px] text-[#AAAAAA]">{aspectRatio}</span>
            <ChevronIcon open={ratioOpen} />
          </Pill>
          {ratioOpen && (
            <FloatMenu>
              {(ratios as readonly string[]).map((r) => (
                <FloatItem key={r} active={aspectRatio === r} onClick={() => { updateNodeData(id, { aspectRatio: r }); setRatioOpen(false); }}>
                  {r}
                </FloatItem>
              ))}
            </FloatMenu>
          )}
        </div>

        {/* Duration */}
        <div className="relative flex-1">
          <Pill fullWidth onClick={() => { setDurOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
            <span className="text-[11px] text-[#AAAAAA] tabular-nums">{duration}s</span>
            <ChevronIcon open={durOpen} />
          </Pill>
          {durOpen && (
            <FloatMenu fullWidth>
              {(durations as readonly number[]).map((d) => (
                <FloatItem key={d} active={duration === d} onClick={() => { updateNodeData(id, { duration: d }); setDurOpen(false); }}>
                  {d}s
                </FloatItem>
              ))}
            </FloatMenu>
          )}
        </div>
      </div>

      {/* ── Row 2: model-specific controls ───────────────────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[#111]">
        {/* Mode picker — shown for any model with cfg.modes (Kling: 720p/1080p, Grok: fun/normal/spicy) */}
        {cfg.modes && (
          <div className="relative">
            <Pill onClick={() => { setModeOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setDurOpen(false); setGrokResOpen(false); }}>
              <span className="text-[11px] text-[#AAAAAA]">
                {cfg.modes.find((m) => m.value === mode)?.label ?? mode}
              </span>
              <ChevronIcon open={modeOpen} />
            </Pill>
            {modeOpen && (
              <FloatMenu>
                {cfg.modes.map((m) => (
                  <FloatItem key={m.value} active={mode === m.value} onClick={() => { updateNodeData(id, { klingMode: m.value }); setModeOpen(false); }}>
                    {m.label}
                  </FloatItem>
                ))}
              </FloatMenu>
            )}
          </div>
        )}

        {/* Resolution picker — shown for models with cfg.resolutions (Grok) */}
        {cfg.resolutions && (
          <div className="relative">
            <Pill onClick={() => { setGrokResOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setDurOpen(false); setModeOpen(false); }}>
              <span className="text-[11px] text-[#AAAAAA]">{resolution}</span>
              <ChevronIcon open={grokResOpen} />
            </Pill>
            {grokResOpen && (
              <FloatMenu>
                {cfg.resolutions.map((r) => (
                  <FloatItem key={r} active={resolution === r} onClick={() => { updateNodeData(id, { grokResolution: r }); setGrokResOpen(false); }}>
                    {r}
                  </FloatItem>
                ))}
              </FloatMenu>
            )}
          </div>
        )}

        {/* Sound toggle — shown for models with cfg.sound (Kling) */}
        {cfg.sound && (
          <>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => updateNodeData(id, { sound: !sound })}
              className="flex items-center gap-2 rounded-full px-2.5 py-1.5 transition-colors"
              style={{ background: "#111317" }}
            >
              <ToggleSwitch on={sound} />
              <span className="text-[11px] text-[#AAAAAA]">Sound</span>
            </button>

            <button
              onMouseDown={(e) => e.stopPropagation()}
              className="w-6 h-6 flex items-center justify-center rounded-full text-[#444] hover:text-[#888] transition-colors"
              style={{ background: "#111317" }}
            >
              <GearIcon />
            </button>
          </>
        )}

        {/* Reference image indicator — shown when resource handle is active and connected */}
        {activeHandles.has("resource") && hasResource && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ background: "#111317" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-[#fb923c] shrink-0" />
            <span className="text-[10px] text-[#AAAAAA]">Img ref</span>
          </div>
        )}

        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-auto ${STATUS_DOT[status]}`} />

        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={generate}
          disabled={busy}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white hover:bg-[#E8E8E8] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          <svg width="9" height="10" viewBox="0 0 9 10" fill="#0A0C0E">
            <path d="M8.5 4.634a.5.5 0 0 1 0 .732l-7.5 4.5A.5.5 0 0 1 .25 9.5v-9A.5.5 0 0 1 1 .17l7.5 4.464Z" />
          </svg>
        </button>
      </div>

      {busy && <SpinnerOverlay color="#3A6FFF" />}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SpinnerOverlay({ color = "#77E544" }: { color?: string }) {
  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex",
      alignItems: "center", justifyContent: "center",
      pointerEvents: "none", zIndex: 20,
    }}>
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" style={{ animation: "spin 0.9s linear infinite" }}>
        <circle cx="14" cy="14" r="11" stroke="#333" strokeWidth="2.5" />
        <path d="M14 3 A11 11 0 0 1 25 14" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function Pill({
  children, onClick, interactive = true, fullWidth = false,
}: {
  children: React.ReactNode; onClick?: () => void;
  interactive?: boolean; fullWidth?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onMouseDown={onClick ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 ${fullWidth ? "w-full justify-between" : ""} ${interactive && onClick ? "hover:brightness-125 transition-all cursor-pointer" : ""
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

function FloatItem({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={`w-full px-3 py-2 text-left text-[11px] hover:bg-[#161A1E] transition-colors ${active ? "text-white font-medium" : "text-[#8D8E89]"}`}
    >
      {children}
    </button>
  );
}

function AspectIcon({ ratio }: { ratio: string }) {
  const [w, h] = ratio === "16:9" ? [11, 7] : ratio === "9:16" ? [7, 11] : ratio === "2:3" ? [7, 11] : ratio === "3:2" ? [11, 7] : [9, 9];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" stroke="#666" strokeWidth="1.2">
      <rect x="0.6" y="0.6" width={w - 1.2} height={h - 1.2} rx="0.8" />
    </svg>
  );
}

function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width="7" height="7" viewBox="0 0 8 8" fill="none" stroke="#555" strokeWidth="1.5" strokeLinecap="round"
      className={`shrink-0 transition-transform duration-100 ${open ? "rotate-180" : ""}`}>
      <path d="M1 2.5 4 5.5 7 2.5" />
    </svg>
  );
}

function ToggleSwitch({ on }: { on: boolean }) {
  return (
    <div className="relative shrink-0 rounded-full transition-colors" style={{ width: 32, height: 18, background: on ? "rgba(119,229,68,0.25)" : "#2A2A2A" }}>
      <div className="absolute top-[3px] rounded-full transition-transform" style={{ width: 12, height: 12, background: on ? "#77E544" : "#555", transform: on ? "translateX(17px)" : "translateX(3px)" }} />
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


function VideoNodeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="m16 10-4-2.5v5L16 10z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PromptIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="white"><path d="M2 2h12v2.5H9.5V14h-3V4.5H2V2z" /></svg>;
}

function VideoRefIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M5.5 4.5v3l3-1.5-3-1.5z" fill="white" stroke="none" />
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
    <svg width="15" height="13" viewBox="0 0 18 15" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="1" width="16" height="13" rx="2" />
      <circle cx="5.5" cy="5" r="1.5" fill="white" stroke="none" />
      <path d="m1 11 4.5-4.5 3 3 2.5-2.5 6 4" />
    </svg>
  );
}
