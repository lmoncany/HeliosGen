"use client";
import { useRef, useCallback, useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { sha256Hex } from "@/lib/assetHash";

type VideoInputNodeType = Node<NodeData, "videoInputNode">;

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

export default function VideoInputNode({ id, data }: NodeProps<VideoInputNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const fileRef        = useRef<HTMLInputElement>(null);
  const videoRef       = useRef<HTMLVideoElement>(null);
  const localUrlRef    = useRef<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const loadFile = useCallback(async (file: File) => {
    setUploadErr(null);

    if (!file.type.startsWith("video/")) {
      setUploadErr("Please select a video file");
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadErr("Video exceeds the 100 MB limit");
      return;
    }

    // Read bytes first — needed for both hash and upload
    const bytes = await file.arrayBuffer();

    // ── Hash + cache lookup (before showing upload progress) ─────────────────
    const hash = await sha256Hex(bytes);
    const { data: authData } = await createClient().auth.getSession();
    const authToken = authData.session?.access_token;
    const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {};

    try {
      const lookupRes  = await fetch(`/api/lookup-asset?hash=${hash}`, { headers: authHeaders });
      const { cdnUrl: cachedUrl } = await lookupRes.json() as { cdnUrl: string | null };
      if (cachedUrl) {
        // Asset already in R2 — skip upload entirely
        updateNodeData(id, { videoUrl: cachedUrl, videoAspectRatio: undefined });
        return;
      }
    } catch {
      // Lookup failed — fall through to normal upload
    }

    // ── Show local preview while uploading ────────────────────────────────────
    if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    const blobUrl = URL.createObjectURL(file);
    localUrlRef.current = blobUrl;
    updateNodeData(id, { videoUrl: blobUrl, videoAspectRatio: undefined });
    setUploading(true);

    try {
      const uploadHeaders: Record<string, string> = {
        "Content-Type": file.type || "video/mp4",
        ...authHeaders,
      };

      const res  = await fetch("/api/upload-asset", { method: "POST", headers: uploadHeaders, body: bytes });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");

      // Swap blob URL for durable CDN URL
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

  const onHoverPlay  = useCallback(() => { videoRef.current?.play().catch(() => {}); }, []);
  const onHoverPause = useCallback(() => { videoRef.current?.pause(); }, []);

  // Self-heal label if it was saved as the raw type key before naming was added
  useEffect(() => {
    const lbl = data.label as string | undefined;
    if (!lbl || lbl === "videoInputNode") {
      updateNodeData(id, { label: "VIDEO #1" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const videoUrl   = data.videoUrl as string | undefined;
  const hasError   = data.hasError as boolean | undefined;
  // Stored as "W / H" string so CSS aspect-ratio can use it directly
  const aspectRatio = (data.videoAspectRatio as string | undefined) ?? "16 / 9";

  const handleAnimEnd = (e: React.AnimationEvent) => {
    if (e.animationName === "node-error-blink") updateNodeData(id, { hasError: false });
  };

  /* ── Loaded state ─────────────────────────────────────────────────────────── */
  if (videoUrl) {
    return (
      <div
        className={`node-card group${hasError ? " node-error-blink" : ""}`}
        style={{
          width: "100%",
          aspectRatio,
          background: "transparent",
          border: "none",
          boxShadow: "none",
        }}
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
              updateNodeData(id, {
                videoAspectRatio: `${v.videoWidth} / ${v.videoHeight}`,
              });
            }}
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
            <div className="h-full bg-white/70 transition-none" style={{ width: `${progress * 100}%` }} />
          </div>

          {/* Upload in-progress overlay */}
          {uploading && (
            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 pointer-events-none">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"
                style={{ animation: "spin 0.9s linear infinite" }}>
                <circle cx="11" cy="11" r="8" stroke="#333" strokeWidth="2.5" />
                <path d="M11 3A8 8 0 0 1 19 11" stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              <span className="text-[10px] text-[#22d3ee]">Uploading…</span>
            </div>
          )}

          {/* Error badge */}
          {uploadErr && !uploading && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1 text-[10px] text-red-400 text-center">
              {uploadErr}
            </div>
          )}

          {/* Hover controls */}
          <div className="absolute bottom-2 left-0 right-0 flex justify-between px-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => fileRef.current?.click()}
              className="text-[10px] text-[#8D8E89] hover:text-white transition-colors relative z-10 pointer-events-auto"
            >
              replace
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (localUrlRef.current) { URL.revokeObjectURL(localUrlRef.current); localUrlRef.current = null; }
                updateNodeData(id, { videoUrl: undefined, videoAspectRatio: undefined });
                setUploadErr(null);
              }}
              className="text-[10px] text-[#8D8E89] hover:text-white transition-colors relative z-10 pointer-events-auto"
            >
              remove
            </button>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.target.value = "";
          }}
        />
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
          <svg
            width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="#22d3ee" strokeWidth="1.5" strokeLinecap="round"
            className="mx-auto mb-2 opacity-40"
          >
            <rect width="18" height="14" x="3" y="5" rx="2" />
            <path d="m16 10-4-2.5v5L16 10z" fill="#22d3ee" stroke="none" />
          </svg>
          <p className="text-[11px] text-[#8D8E89]">
            Drop video or{" "}
            <span className="underline underline-offset-2 text-white">browse</span>
          </p>
          <p className="text-[10px] text-[#4A4A45] mt-1">Max 100 MB</p>
        </div>

        {uploadErr && (
          <p className="text-[10px] text-red-400 mt-1.5 text-center">{uploadErr}</p>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
