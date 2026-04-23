"use client";
import React, { useState } from "react";

/* ─── Icon components ──────────────────────────────────────────────────────── */

const IconAdd = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const IconSelect = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4l7.07 17 2.51-7.39L21 11.07z" />
  </svg>
);

const IconHand = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 11V7a2 2 0 0 0-4 0" />
    <path d="M14 10V4.5a2 2 0 0 0-4 0V10" />
    <path d="M10 10V6a2 2 0 0 0-4 0v8" />
    <path d="M6 14v-2a2 2 0 0 0-2-2H4" />
    <path d="M18 11a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L8 15" />
  </svg>
);

const IconScissors = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="m20 4-8.12 8.12" />
    <path d="M8.93 14.93 20 20" />
    <path d="m14.5 9.5 1 1" />
  </svg>
);

const IconFrame = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" strokeWidth="1.4" opacity="0.5" />
  </svg>
);

const IconComment = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const IconUndo = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </svg>
);

const IconRedo = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
  </svg>
);

const IconSettings = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type ToolId = "select" | "hand" | "cut" | "frame" | "comment";

interface CanvasToolbarProps {
  /** Controlled from outside (optional) — defaults to "select" */
  activeTool?: ToolId;
  onToolChange?: (tool: ToolId) => void;
  onAddNode?: (anchorRect: DOMRect) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onOpenSettings?: () => void;
}

/* ─── Sub-components ────────────────────────────────────────────────────────── */

function Divider() {
  return (
    <span
      style={{
        display: "block",
        width: "28px",
        height: "1px",
        background: "rgba(255,255,255,0.06)",
        margin: "2px auto",
        flexShrink: 0,
      }}
    />
  );
}

interface BtnProps {
  id: string;
  title: string;
  active?: boolean;
  activeStyle?: "circle" | "highlight";
  dimmed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function Btn({ id, title, active, activeStyle = "highlight", dimmed, onClick, children }: BtnProps) {
  const [hovered, setHovered] = useState(false);

  const isCircleActive = active && activeStyle === "circle";

  return (
    <button
      id={id}
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "36px",
        height: "36px",
        borderRadius: "50%",
        border: "none",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 150ms ease, color 150ms ease, opacity 150ms ease",
        background: isCircleActive
          ? "rgba(255,255,255,0.92)"
          : hovered
          ? "rgba(255,255,255,0.07)"
          : "transparent",
        color: dimmed
          ? "rgba(255,255,255,0.2)"
          : isCircleActive
          ? "#111"
          : active
          ? "rgba(255,255,255,0.9)"
          : hovered
          ? "rgba(255,255,255,0.8)"
          : "rgba(255,255,255,0.45)",
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

/* ─── Main component ────────────────────────────────────────────────────────── */

export default function CanvasToolbar({
  activeTool: externalTool,
  onToolChange,
  onAddNode,
  onUndo,
  onRedo,
  canUndo = true,
  canRedo = false,
  onOpenSettings,
}: CanvasToolbarProps) {
  const [internalTool, setInternalTool] = useState<ToolId>("select");
  const activeTool = externalTool ?? internalTool;

  function selectTool(tool: ToolId) {
    setInternalTool(tool);
    onToolChange?.(tool);
  }

  return (
    <div
      id="canvas-toolbar"
      style={{
        position: "absolute",
        left: "16px",
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
        padding: "10px 4px",
        borderRadius: "999px",
        background: "rgba(14, 14, 14, 0.92)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.55), 0 1px 6px rgba(0,0,0,0.35)",
        userSelect: "none",
      }}
    >
      {/* Add node */}
      <button
        id="toolbar-add"
        title="Add node (A)"
        onClick={(e) => onAddNode?.((e.currentTarget as HTMLElement).getBoundingClientRect())}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "36px",
          height: "36px",
          borderRadius: "50%",
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
          background: "transparent",
          color: "rgba(255,255,255,0.55)",
          transition: "background 150ms ease, color 150ms ease",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.9)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.55)";
        }}
      >
        <IconAdd />
      </button>

      <Divider />

      {/* Select */}
      <Btn
        id="toolbar-select"
        title="Select (V)"
        active={activeTool === "select"}
        activeStyle="circle"
        onClick={() => selectTool("select")}
      >
        <IconSelect />
      </Btn>

      {/* Hand / Pan */}
      <Btn
        id="toolbar-hand"
        title="Hand tool (H)"
        active={activeTool === "hand"}
        onClick={() => selectTool("hand")}
      >
        <IconHand />
      </Btn>

      <Divider />

      {/* Scissors / Cut */}
      <Btn
        id="toolbar-cut"
        title="Cut edges (X)"
        active={activeTool === "cut"}
        onClick={() => selectTool("cut")}
      >
        <IconScissors />
      </Btn>

      {/* Frame */}
      <Btn
        id="toolbar-frame"
        title="Add frame"
        active={activeTool === "frame"}
        onClick={() => selectTool("frame")}
      >
        <IconFrame />
      </Btn>

      {/* Comment */}
      <Btn
        id="toolbar-comment"
        title="Add comment"
        active={activeTool === "comment"}
        onClick={() => selectTool("comment")}
      >
        <IconComment />
      </Btn>

      <Divider />

      {/* Undo */}
      <Btn
        id="toolbar-undo"
        title="Undo (⌘Z)"
        dimmed={!canUndo}
        onClick={() => onUndo?.()}
      >
        <IconUndo />
      </Btn>

      {/* Redo */}
      <Btn
        id="toolbar-redo"
        title="Redo (⌘⇧Z)"
        dimmed={!canRedo}
        onClick={() => onRedo?.()}
      >
        <IconRedo />
      </Btn>

      <Divider />

      {/* Settings */}
      <Btn
        id="toolbar-settings"
        title="Settings"
        onClick={() => onOpenSettings?.()}
      >
        <IconSettings />
      </Btn>
    </div>
  );
}
