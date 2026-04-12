"use client";
import { useCallback } from "react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { edgeStyle } from "@/lib/edgeStyles";
import { Node, Edge } from "@xyflow/react";
import { NODES, NODE_SIZE, FALLBACK_SIZE } from "@/lib/nodeTypes";

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

      // imageInputNode height is content-driven (sized by the image ratio at runtime)
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

      {/* Node list */}
      <div className="flex-1 p-3 space-y-1">
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
