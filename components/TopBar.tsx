"use client";
import { useEffect, useRef, useState } from "react";

interface TopBarProps {
  isRunning: boolean;
  canRun: boolean;
  onRunAll: () => void;
  hasNodes: boolean;
  onClear: () => void;
}

export default function TopBar({
  isRunning, canRun, onRunAll, hasNodes, onClear,
}: TopBarProps) {
  const prevRunning = useRef(false);

  const initialDPR = useRef(typeof window !== "undefined" ? window.devicePixelRatio : 1);
  const [counterZoom, setCounterZoom] = useState(1);
  useEffect(() => {
    const update = () => {
      const browserZoom = window.devicePixelRatio / initialDPR.current;
      setCounterZoom(1 / browserZoom);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Refresh navbar credits after a run completes by dispatching a custom event
  useEffect(() => {
    if (prevRunning.current && !isRunning) {
      window.dispatchEvent(new Event("credits-refresh"));
    }
    prevRunning.current = isRunning;
  }, [isRunning]);

  return (
    <div
      style={{
        display:        "flex",
        alignItems:     "center",
        justifyContent: "flex-end",
        height:         "40px",
        padding:        "0 12px",
        borderBottom:   "1px solid rgba(255,255,255,0.05)",
        background:     "#080A0C",
        flexShrink:     0,
        userSelect:     "none",
        position:       "relative",
        zIndex:         10,
        zoom:           counterZoom,
        gap:            "8px",
      }}
    >
      {hasNodes && (
        <button onClick={onClear} disabled={isRunning} className="toolbar-btn">
          Clear
        </button>
      )}

      <button onClick={onRunAll} disabled={!canRun} className="toolbar-btn-primary">
        {isRunning ? (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 border border-[#2A1A14] border-t-transparent rounded-full animate-spin" />
            Running
          </span>
        ) : (
          "Run all"
        )}
      </button>

    </div>
  );
}
