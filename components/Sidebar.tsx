"use client";
import { useCallback } from "react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { edgeStyle } from "@/lib/edgeStyles";
import { Node, Edge } from "@xyflow/react";

const NODES = [
  {
    type: "generateNode",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="m3 9 4-4 4 4 4-4 4 4" />
        <path d="M3 15h18" />
      </svg>
    ),
    label: "Image",
    description: "Nano Banana 2 · always paired with text",
  },
  {
    type: "imageInputNode",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      </svg>
    ),
    label: "Image",
    description: "Upload or URL source",
  },
  {
    type: "promptNode",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    label: "Text",
    description: "Standalone text source",
  },
];

// Rough size estimates per node type (width × height in px)
const NODE_SIZE: Record<string, { w: number; h: number }> = {
  generateNode:   { w: 280, h: 340 },
  promptNode:     { w: 260, h: 130 },
  imageInputNode: { w: 240, h: 220 },
};
const FALLBACK_SIZE = { w: 280, h: 280 };
const GAP = 10;

// Find the closest free position to the existing cluster.
// Generates candidates adjacent to every existing node (right, left, below, above)
// then picks the one nearest to the centroid that doesn't overlap anything.
function findFreePosition(
  nodes: Node<NodeData>[],
  fw: number, // footprint width
  fh: number, // footprint height
): { x: number; y: number } {
  if (nodes.length === 0) return { x: 80, y: 80 };

  // Centroid of existing nodes (used to rank candidates by proximity)
  const cx = nodes.reduce((s, n) => s + n.position.x, 0) / nodes.length;
  const cy = nodes.reduce((s, n) => s + n.position.y, 0) / nodes.length;

  // Does a candidate rect (x,y,fw,fh) collide with any existing node?
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

  // Build candidates: all 4 sides of every existing node
  const candidates: { x: number; y: number }[] = [];
  for (const n of nodes) {
    const s = NODE_SIZE[n.type ?? ""] ?? FALLBACK_SIZE;
    // right
    candidates.push({ x: n.position.x + s.w + GAP, y: n.position.y });
    // left
    candidates.push({ x: n.position.x - fw - GAP,  y: n.position.y });
    // below
    candidates.push({ x: n.position.x, y: n.position.y + s.h + GAP });
    // above
    candidates.push({ x: n.position.x, y: n.position.y - fh - GAP });
    // right, vertically centred on existing node
    candidates.push({ x: n.position.x + s.w + GAP, y: n.position.y + (s.h - fh) / 2 });
    // below, horizontally centred on existing node
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

  // Fallback: place to the right of everything
  const maxX = Math.max(...nodes.map((n) => n.position.x + (NODE_SIZE[n.type ?? ""] ?? FALLBACK_SIZE).w));
  return { x: maxX + GAP, y: cy - fh / 2 };
}

// Unique ID that survives hot-reloads and page refreshes without colliding
// with IDs already persisted in localStorage.
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export default function Sidebar() {
  const addNode    = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);
  const nodes      = useWorkflowStore((s) => s.nodes);

  const add = useCallback(
    (type: string) => {
      if (type === "generateNode") {
        // Footprint = prompt node (260) + gap (60) + generator (280) wide, tallest = generator
        const { x, y } = findFreePosition(nodes, 260 + 60 + 280, 340);

        const genId    = `gen-${uid()}`;
        const promptId = `prompt-${uid()}`;

        const promptNode: Node<NodeData> = {
          id: promptId,
          type: "promptNode",
          position: { x, y: y + 20 },
          deletable: false,
          data: { label: "promptNode" },
        };

        const genNode: Node<NodeData> = {
          id: genId,
          type: "generateNode",
          position: { x: x + 320, y },
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

      const node: Node<NodeData> = {
        id: `${type}-${uid()}`,
        type,
        position: { x, y },
        data: { label: type, status: "idle" },
      };
      addNode(node);
    },
    [addNode, insertEdge, nodes]
  );

  return (
    <aside className="w-48 bg-[#0c0c0c] border-r border-[#181818] flex flex-col shrink-0">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-[#181818]">
        <span className="text-[#e8e8e8] text-sm font-medium tracking-tight">
          AI Workflow
        </span>
      </div>

      {/* Node list */}
      <div className="flex-1 p-3 space-y-1">
        <p className="text-[#383838] text-[10px] uppercase tracking-widest px-1 py-2">
          Nodes
        </p>
        {NODES.map((n) => (
          <button
            key={n.type + n.label}
            onClick={() => add(n.type)}
            className="w-full text-left px-3 py-2.5 rounded hover:bg-[#161616] transition-colors group"
          >
            <div className="flex items-center gap-2.5 text-[#666] group-hover:text-[#aaa] transition-colors">
              {n.icon}
              <span className="text-[13px] text-[#aaa] group-hover:text-[#ddd] font-medium transition-colors">
                {n.label}
              </span>
            </div>
            <p className="text-[10px] text-[#383838] group-hover:text-[#555] mt-0.5 pl-[22px] transition-colors">
              {n.description}
            </p>
          </button>
        ))}
      </div>

      <div className="p-3 border-t border-[#181818]">
        <p className="text-[10px] text-[#2e2e2e] leading-4">
          Click to add nodes · Drag handles to connect
        </p>
      </div>
    </aside>
  );
}
