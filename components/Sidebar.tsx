"use client";
import { useCallback, useRef, useState } from "react";
import { useWorkflowStore, NodeData, Space } from "@/lib/store";
import { edgeStyle } from "@/lib/edgeStyles";
import { Node, Edge } from "@xyflow/react";
import { NODES, NODE_SIZE, FALLBACK_SIZE } from "@/lib/nodeTypes";

const GAP = 10;

function findFreePosition(
  nodes: Node<NodeData>[],
  fw: number,
  fh: number,
): { x: number; y: number } {
  if (nodes.length === 0) return { x: 80, y: 80 };
  const cx = nodes.reduce((s, n) => s + n.position.x, 0) / nodes.length;
  const cy = nodes.reduce((s, n) => s + n.position.y, 0) / nodes.length;
  const hits = (x: number, y: number) =>
    nodes.some((n) => {
      const s = NODE_SIZE[n.type ?? ""] ?? FALLBACK_SIZE;
      return !(
        x + fw + GAP <= n.position.x ||
        x            >= n.position.x + s.w + GAP ||
        y + fh + GAP <= n.position.y ||
        y            >= n.position.y + s.h + GAP
      );
    });
  const candidates: { x: number; y: number }[] = [];
  for (const n of nodes) {
    const s = NODE_SIZE[n.type ?? ""] ?? FALLBACK_SIZE;
    candidates.push({ x: n.position.x + s.w + GAP, y: n.position.y });
    candidates.push({ x: n.position.x - fw - GAP,  y: n.position.y });
    candidates.push({ x: n.position.x, y: n.position.y + s.h + GAP });
    candidates.push({ x: n.position.x, y: n.position.y - fh - GAP });
    candidates.push({ x: n.position.x + s.w + GAP, y: n.position.y + (s.h - fh) / 2 });
    candidates.push({ x: n.position.x + (s.w - fw) / 2, y: n.position.y + s.h + GAP });
  }
  const valid = candidates
    .filter((c) => !hits(c.x, c.y))
    .sort((a, b) => {
      const da = Math.hypot(a.x + fw / 2 - cx, a.y + fh / 2 - cy);
      const db = Math.hypot(b.x + fw / 2 - cx, b.y + fh / 2 - cy);
      return da - db;
    });
  if (valid.length > 0) return valid[0];
  const maxX = Math.max(...nodes.map((n) => n.position.x + (NODE_SIZE[n.type ?? ""] ?? FALLBACK_SIZE).w));
  return { x: maxX + GAP, y: cy - fh / 2 };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Spaces panel ──────────────────────────────────────────────────────────────

function SpacesPanel() {
  const spaces        = useWorkflowStore((s) => s.spaces);
  const activeSpaceId = useWorkflowStore((s) => s.activeSpaceId);
  const createSpace   = useWorkflowStore((s) => s.createSpace);
  const switchSpace   = useWorkflowStore((s) => s.switchSpace);
  const renameSpace   = useWorkflowStore((s) => s.renameSpace);
  const deleteSpace   = useWorkflowStore((s) => s.deleteSpace);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = (sp: Space) => {
    setEditingId(sp.id);
    setDraft(sp.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (editingId && draft.trim()) renameSpace(editingId, draft.trim());
    setEditingId(null);
  };

  const addSpace = () => {
    const n = spaces.length + 1;
    createSpace(`Space ${n}`);
  };

  return (
    <div className="border-b border-[#1A100C]">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[10px] uppercase tracking-widest text-[#8D8E89]">Spaces</span>
        <button
          onClick={addSpace}
          className="w-4 h-4 flex items-center justify-center rounded text-[#8D8E89] hover:text-white hover:bg-[#1A100C] transition-colors"
          title="New space"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 1v6M1 4h6" />
          </svg>
        </button>
      </div>

      <div className="pb-2 space-y-px px-2">
        {spaces.map((sp) => {
          const active = sp.id === activeSpaceId;
          const nodeCount = sp.nodes.filter(
            (n) => n.type === "generateNode" || n.type === "videoGeneratorNode"
          ).length;

          return (
            <div
              key={sp.id}
              onClick={() => { if (!active) switchSpace(sp.id); }}
              className={`group flex items-center gap-2 px-2 py-2 rounded cursor-pointer transition-colors ${
                active ? "bg-[#0D1012]" : "hover:bg-[#0A0C0E]"
              }`}
            >
              {/* Space icon */}
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? "bg-[#77E544]" : "bg-[#2A1A14]"}`} />

              {/* Name / rename input */}
              {editingId === sp.id ? (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 bg-transparent text-[12px] text-white outline-none border-b border-[#77E544]"
                />
              ) : (
                <span
                  onDoubleClick={(e) => { e.stopPropagation(); startRename(sp); }}
                  className={`flex-1 min-w-0 text-[12px] truncate ${active ? "text-white" : "text-[#8D8E89]"}`}
                >
                  {sp.name}
                </span>
              )}

              {/* Node count badge */}
              {nodeCount > 0 && (
                <span className="text-[10px] text-[#4A4A45] tabular-nums shrink-0">{nodeCount}</span>
              )}

              {/* Delete button — hidden until hover, disabled if only space */}
              {spaces.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); deleteSpace(sp.id); }}
                  className="opacity-0 group-hover:opacity-100 shrink-0 w-3.5 h-3.5 flex items-center justify-center text-[#8D8E89] hover:text-red-400 transition-colors"
                  title="Delete space"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M1 1l6 6M7 1L1 7" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const addNode    = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);
  const nodes      = useWorkflowStore((s) => s.nodes);

  const add = useCallback(
    (type: string) => {
      if (type === "generateNode") {
        const { x, y } = findFreePosition(nodes, 260 + 60 + 280, 340);

        const genId    = `gen-${uid()}`;
        const promptId = `prompt-${uid()}`;

        const promptNode: Node<NodeData> = {
          id: promptId,
          type: "promptNode",
          position: { x, y: y + 20 },
          deletable: false,
          style: { width: NODE_SIZE.promptNode.w, height: NODE_SIZE.promptNode.h },
          data: { label: "promptNode" },
        };

        const genNode: Node<NodeData> = {
          id: genId,
          type: "generateNode",
          position: { x: x + 320, y },
          style: { width: NODE_SIZE.generateNode.w, height: NODE_SIZE.generateNode.h },
          data: { label: "generateNode", status: "idle", model: "nano-banana-2", aspectRatio: "1:1" },
        };

        const edge: Edge = {
          id: `edge-${promptId}-${genId}`,
          source: promptId,
          target: genId,
          targetHandle: "prompt",
          deletable: false,
          reconnectable: false,
          animated: false,
          style: edgeStyle("prompt"),
        };

        addNode(promptNode);
        addNode(genNode);
        insertEdge(edge);
        return;
      }

      const size = NODE_SIZE[type] ?? FALLBACK_SIZE;
      const { x, y } = findFreePosition(nodes, size.w, size.h);

      const nodeStyle = type === "imageInputNode"
        ? { width: size.w }
        : { width: size.w, height: size.h };

      const node: Node<NodeData> = {
        id: `${type}-${uid()}`,
        type,
        position: { x, y },
        style: nodeStyle,
        data: { label: type, status: "idle" },
      };
      addNode(node);
    },
    [addNode, insertEdge, nodes]
  );

  return (
    <aside className="w-48 bg-[#0A0C0E] border-r border-[#1A100C] flex flex-col shrink-0">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-[#1A100C]">
        <span className="text-white text-sm font-medium tracking-tight">
          AI Workflow
        </span>
      </div>

      {/* Spaces */}
      <SpacesPanel />

      {/* Node list */}
      <div className="flex-1 p-3 space-y-1 overflow-y-auto">
        <p className="text-[#8D8E89] text-[10px] uppercase tracking-widest px-1 py-2">
          Nodes
        </p>
        {NODES.map((n) => (
          <button
            key={n.type + n.label}
            onClick={() => add(n.type)}
            className="w-full text-left px-3 py-2.5 rounded hover:bg-[#0D1012] transition-colors group"
          >
            <div className="flex items-center gap-2.5 text-[#8D8E89] group-hover:text-[#77E544] transition-colors">
              {n.icon}
              <span className="text-[13px] text-white group-hover:text-white font-medium transition-colors">
                {n.label}
              </span>
            </div>
            <p className="text-[10px] text-[#8D8E89] group-hover:text-[#8D8E89] mt-0.5 pl-[22px] transition-colors">
              {n.description}
            </p>
          </button>
        ))}
      </div>

      <div className="p-3 border-t border-[#1A100C]">
        <p className="text-[10px] text-[#4A4A45] leading-4">
          Click to add nodes · Drag handles to connect
        </p>
      </div>
    </aside>
  );
}
