"use client";
import { useRef, useCallback, useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { sha256Hex } from "@/lib/assetHash";

type VideoInputNodeType = Node<NodeData, "videoInputNode">;

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const IMAGE_HANDLES = new Set(["startFrame", "endFrame", "resource", "image"]);

export default function VideoInputNode({ id, data }: NodeProps<VideoInputNodeType>) {
  const updateNodeData  = useWorkflowStore((s) => s.updateNodeData);
  const edges           = useWorkflowStore((s) => s.edges);
  const { deleteElements } = useReactFlow();
  const fileRef        = useRef<HTMLInputElement>(null);
  const videoRef       = useRef<HTMLVideoElement>(null);
  const localUrlRef    = useRef<string | null>(null);

  const [uploading, setUploading]   = useState(false);
  const [uploadErr, setUploadErr]   = useState<string | null>(null);
  const [muted, setMuted]           = useState(true);
  const [progress, setProgress]     = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const [pickerOpen, setPickerOpen]   = useState(false);
  const [capturing, setCapturing]     = useState(false);
  const [captureErr, setCaptureErr]   = useState<string | null>(null);
  const [scrubPos, setScrubPos]       = useState(0);

  const fmtTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // Is this node wired to any downstream image handle?
  const imageEdge = edges.find(
    (e) => e.source === id && IMAGE_HANDLES.has(e.targetHandle as string)
  );
  const connectedToImageHandle = !!imageEdge;
  const capturedFrameUrl = data.capturedFrameUrl as string | undefined;
  const capturedFrameRef  = useRef(capturedFrameUrl);
  capturedFrameRef.current = capturedFrameUrl;

  // ── Frame picker ────────────────────────────────────────────────────────────

  const openPicker = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      setScrubPos(v.currentTime / (v.duration || 1));
    }
    setPickerOpen(true);
  }, []);

  const captureFrame = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    setCaptureErr(null);
    setCapturing(true);
    try {
      const seekTime = v.currentTime;
      const srcUrl   = v.src;
      const w = v.videoWidth  || 1280;
      const h = v.videoHeight || 720;

      // Use a temporary off-screen video via our CORS proxy so the canvas isn't tainted.
      // Blob URLs (local uploads) are same-origin and don't need a proxy.
      const proxyUrl = srcUrl.startsWith("blob:")
        ? srcUrl
        : `/api/video-proxy?url=${encodeURIComponent(srcUrl)}`;

      const blob: Blob = await new Promise((resolve, reject) => {
        const tmp = document.createElement("video");
        tmp.crossOrigin = "anonymous";
        tmp.muted       = true;
        tmp.preload     = "metadata";
        tmp.src         = proxyUrl;

        const cleanup = () => { tmp.src = ""; tmp.remove(); };

        tmp.addEventListener("error", () => { cleanup(); reject(new Error("Could not load video for capture")); }, { once: true });
        tmp.addEventListener("loadedmetadata", () => { tmp.currentTime = seekTime; }, { once: true });
        tmp.addEventListener("seeked", () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width  = w;
            canvas.height = h;
            canvas.getContext("2d")!.drawImage(tmp, 0, 0, w, h);
            canvas.toBlob((b) => {
              cleanup();
              if (b) resolve(b);
              else reject(new Error("Canvas capture returned empty"));
            }, "image/jpeg", 0.95);
          } catch (e) {
            cleanup();
            reject(e);
          }
        }, { once: true });
      });

      const bytes = await blob.arrayBuffer();
      const { data: authData } = await createClient().auth.getSession();
      const token = authData.session?.access_token;
      const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      const res  = await fetch("/api/upload-asset", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", ...authHeaders },
        body: bytes,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");

      updateNodeData(id, { capturedFrameUrl: json.cdnUrl });
      setPickerOpen(false);
    } catch (err) {
      setCaptureErr(err instanceof Error ? err.message : "Capture failed");
    } finally {
      setCapturing(false);
    }
  }, [id, updateNodeData]);

  // Auto-open picker when connected; close picker + unlock when edge is cut
  const imageEdgeId = imageEdge?.id ?? null;
  useEffect(() => {
    if (imageEdgeId && !capturedFrameRef.current) setPickerOpen(true);
    if (!imageEdgeId) {
      setPickerOpen(false);
      if (capturedFrameRef.current) updateNodeData(id, { capturedFrameUrl: undefined });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageEdgeId]);

  // ── Video upload ─────────────────────────────────────────────────────────────

  const loadFile = useCallback(async (file: File) => {
    setUploadErr(null);

    if (!file.type.startsWith("video/")) { setUploadErr("Please select a video file"); return; }
    if (file.size > MAX_BYTES) { setUploadErr("Video exceeds the 100 MB limit"); return; }

    const bytes = await file.arrayBuffer();
    const hash  = await sha256Hex(bytes);
    const { data: authData } = await createClient().auth.getSession();
    const token = authData.session?.access_token;
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    try {
      const lookupRes = await fetch(`/api/lookup-asset?hash=${hash}`, { headers: authHeaders });
      const { cdnUrl: cached } = await lookupRes.json() as { cdnUrl: string | null };
      if (cached) {
        updateNodeData(id, { videoUrl: cached, videoAspectRatio: undefined, capturedFrameUrl: undefined });
        return;
      }
    } catch { /* fall through */ }

    if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    const blobUrl = URL.createObjectURL(file);
    localUrlRef.current = blobUrl;
    updateNodeData(id, { videoUrl: blobUrl, videoAspectRatio: undefined, capturedFrameUrl: undefined });
    setUploading(true);

    try {
      const res  = await fetch("/api/upload-asset", {
        method: "POST",
        headers: { "Content-Type": file.type || "video/mp4", ...authHeaders },
        body: bytes,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      URL.revokeObjectURL(blobUrl);
      localUrlRef.current = null;
      updateNodeData(id, { videoUrl: json.cdnUrl });
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [id, updateNodeData]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith("video/")) loadFile(file);
  }, [loadFile]);

  const onHoverPlay  = useCallback(() => {
    if (!pickerOpen && !capturedFrameRef.current) videoRef.current?.play().catch(() => {});
  }, [pickerOpen]);
  const onHoverPause = useCallback(() => {
    if (!pickerOpen && !capturedFrameRef.current) videoRef.current?.pause();
  }, [pickerOpen]);

  useEffect(() => {
    const lbl = data.label as string | undefined;
    if (!lbl || lbl === "videoInputNode") updateNodeData(id, { label: "VIDEO #1" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const videoUrl    = data.videoUrl as string | undefined;
  const hasError    = data.hasError as boolean | undefined;
  const aspectRatio = (data.videoAspectRatio as string | undefined) ?? "16 / 9";

  const handleAnimEnd = (e: React.AnimationEvent) => {
    if (e.animationName === "node-error-blink") updateNodeData(id, { hasError: false });
  };


  /* ── Loaded state — video player ────────────────────────────────────────────── */
  if (videoUrl) {
    return (
      <div
        className={`node-card group${hasError ? " node-error-blink" : ""}`}
        style={{ width: "100%", aspectRatio, background: "transparent", border: "none", boxShadow: "none" }}
        onAnimationEnd={handleAnimEnd}
      >
        <CornerResizer minWidth={160} minHeight={80} keepAspectRatio />
        <span className="node-above-label">{data.label as string}</span>
        <Handle type="source" position={Position.Right} className="node-handle node-handle-video" />

        <div
          className="relative w-full h-full overflow-hidden rounded-[7px] group/player"
          onMouseEnter={onHoverPlay}
          onMouseLeave={onHoverPause}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            key={videoUrl}
            src={videoUrl}
            className="w-full h-full block"
            style={{ objectFit: "fill" }}
            muted={muted}
            playsInline
            preload="metadata"
            loop
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (!v.videoWidth || !v.videoHeight) return;
              updateNodeData(id, { videoAspectRatio: `${v.videoWidth} / ${v.videoHeight}` });
            }}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              setCurrentSec(v.currentTime);
              if (v.duration) {
                const pct = v.currentTime / v.duration;
                setProgress(pct);
                if (pickerOpen) setScrubPos(pct);
              }
            }}
          />

          {/* ── Normal player controls (hidden while picker is open) ── */}
          {!pickerOpen && (
            <>
              {/* Timer badge */}
              <div className="absolute top-2 left-2 h-7 px-2 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/player:opacity-100 transition-opacity z-10 pointer-events-none">
                <span className="text-[11px] text-white font-mono tabular-nums">{fmtTime(currentSec)}</span>
              </div>

              {/* Mute button */}
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/player:opacity-100 transition-opacity pointer-events-auto z-10"
                title={muted ? "Unmute" : "Mute"}
              >
                {muted ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                )}
              </button>

              {/* Progress bar */}
              <div
                className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/10 opacity-0 group-hover/player:opacity-100 transition-opacity"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const v = videoRef.current;
                  if (v && v.duration) v.currentTime = ((e.clientX - rect.left) / rect.width) * v.duration;
                }}
                style={{ cursor: "pointer" }}
              >
                <div className="h-full bg-white/70 transition-none" style={{ width: `${progress * 100}%` }} />
              </div>

              {/* Hover controls row — only when not locked */}
              {!capturedFrameUrl && (
                <div className="absolute bottom-2 left-0 right-0 flex justify-between px-2.5 opacity-0 group-hover/player:opacity-100 transition-opacity">
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => fileRef.current?.click()}
                    className="text-[10px] text-[#8D8E89] hover:text-white transition-colors relative z-10 pointer-events-auto"
                  >replace</button>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (localUrlRef.current) { URL.revokeObjectURL(localUrlRef.current); localUrlRef.current = null; }
                      updateNodeData(id, { videoUrl: undefined, videoAspectRatio: undefined, capturedFrameUrl: undefined });
                      setUploadErr(null);
                    }}
                    className="text-[10px] text-[#8D8E89] hover:text-white transition-colors relative z-10 pointer-events-auto"
                  >remove</button>
                </div>
              )}

              {/* "Pick a frame" CTA — shown on hover when connected but not locked */}
              {connectedToImageHandle && !capturedFrameUrl && (
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); openPicker(); }}
                  className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/player:opacity-100 transition-opacity pointer-events-auto z-10"
                >
                  <span className="flex items-center gap-1.5 h-7 px-3 rounded-full bg-black/50 backdrop-blur-sm text-[11px] text-white font-medium">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 3" />
                    </svg>
                    Pick a frame
                  </span>
                </button>
              )}

              {/* Lock icon — shown in center when frame is captured */}
              {capturedFrameUrl && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="none">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Frame picker overlay ─────────────────────────────────── */}
          {pickerOpen && (
            <div
              className="nodrag absolute inset-0 flex flex-col z-20 bg-black/50"
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Scrubber + time */}
              <div className="mt-auto px-3 pb-3 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-white font-mono tabular-nums">{fmtTime(currentSec)}</span>
                  {captureErr
                    ? <span className="text-[10px] text-red-400">{captureErr}</span>
                    : <span className="text-[10px] text-white/40">drag to seek</span>
                  }
                </div>
                <input
                  type="range" min={0} max={1} step={0.0001}
                  value={scrubPos}
                  onChange={(e) => {
                    const pct = parseFloat(e.target.value);
                    setScrubPos(pct);
                    const v = videoRef.current;
                    if (v && v.duration) v.currentTime = pct * v.duration;
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="nodrag w-full cursor-pointer accent-white"
                />
                <div className="flex gap-2">
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); captureFrame(); }}
                    disabled={capturing}
                    className="nodrag flex-1 h-7 rounded-full bg-white/90 text-black text-[11px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    {capturing ? (
                      <>
                        <svg width="11" height="11" viewBox="0 0 22 22" fill="none" style={{ animation: "spin 0.9s linear infinite" }}>
                          <circle cx="11" cy="11" r="8" stroke="#333" strokeWidth="2.5" />
                          <path d="M11 3A8 8 0 0 1 19 11" stroke="#000" strokeWidth="2.5" strokeLinecap="round" />
                        </svg>
                        Capturing…
                      </>
                    ) : (
                      <>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="3" /><path d="M20 7h-3.2L15 5H9L7.2 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
                        </svg>
                        Use this frame
                      </>
                    )}
                  </button>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (imageEdgeId) deleteElements({ edges: [{ id: imageEdgeId }] });
                    }}
                    className="nodrag h-7 px-3 rounded-full bg-white/10 text-white text-[11px] flex items-center justify-center cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Upload overlay */}
          {uploading && (
            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 pointer-events-none">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style={{ animation: "spin 0.9s linear infinite" }}>
                <circle cx="11" cy="11" r="8" stroke="#333" strokeWidth="2.5" />
                <path d="M11 3A8 8 0 0 1 19 11" stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              <span className="text-[10px] text-[#22d3ee]">Uploading…</span>
            </div>
          )}

          {uploadErr && !uploading && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1 text-[10px] text-red-400 text-center">
              {uploadErr}
            </div>
          )}
        </div>

        <input ref={fileRef} type="file" accept="video/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }} />
      </div>
    );
  }

  /* ── Empty state ──────────────────────────────────────────────────────────── */
  return (
    <div
      className={`node-card w-full${hasError ? " node-error-blink" : ""}`}
      style={{ minWidth: 200 }}
      onAnimationEnd={handleAnimEnd}
    >
      <CornerResizer minWidth={160} minHeight={100} />
      <span className="node-above-label">{data.label as string}</span>
      <Handle type="source" position={Position.Right} className="node-handle node-handle-video" />

      <div className="overflow-hidden rounded-[7px] p-2.5">
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
          className="border border-dashed border-[#22d3ee]/20 hover:border-[#22d3ee]/40 rounded-md cursor-pointer transition-colors py-8 text-center"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinecap="round" className="mx-auto mb-2 opacity-40">
            <rect width="18" height="14" x="3" y="5" rx="2" />
            <path d="m16 10-4-2.5v5L16 10z" fill="#22d3ee" stroke="none" />
          </svg>
          <p className="text-[11px] text-[#8D8E89]">Drop video or{" "}<span className="underline underline-offset-2 text-white">browse</span></p>
          <p className="text-[10px] text-[#4A4A45] mt-1">Max 100 MB</p>
        </div>
        {uploadErr && <p className="text-[10px] text-red-400 mt-1.5 text-center">{uploadErr}</p>}
      </div>

      <input ref={fileRef} type="file" accept="video/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }} />
    </div>
  );
}
