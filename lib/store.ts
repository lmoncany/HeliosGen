import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { edgeStyle } from "./edgeStyles";
import {
  Node,
  Edge,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  NodeChange,
  EdgeChange,
  Connection,
} from "@xyflow/react";

export type NodeStatus = "idle" | "running" | "done" | "error";
export type GenerateMode = "t2i" | "t2v" | "i2i" | "i2v";

export interface NodeData extends Record<string, unknown> {
  label: string;
  status?: NodeStatus;
  // shared
  prompt?: string;
  // generate node
  mode?: GenerateMode;
  model?: string;
  aspectRatio?: string;
  duration?: number;
  // image (input or output)
  imageUrl?: string;
  inputImage?: string;
  imageNaturalRatio?: string;
  // generation settings
  quality?: string;
  // video output
  videoUrl?: string;
  // kling 3.0 settings
  sound?: boolean;
  klingMode?: string;
  count?: number;
  // error
  errorMsg?: string;
  // validation
  hasError?: boolean;
  // pending job
  taskId?: string;
}

/** Human-readable label for each node type, including the counter */
export function getNodeLabel(type: string, n: number): string {
  const map: Record<string, string> = {
    promptNode:          `Text #${n}`,
    imageInputNode:      `Image #${n}`,
    generateNode:        `Generator #${n}`,
    videoGeneratorNode:  `Video Generator #${n}`,
  };
  return map[type] ?? `Node #${n}`;
}

interface WorkflowStore {
  nodes: Node<NodeData>[];
  edges: Edge[];
  isRunning: boolean;
  debugMode: boolean;
  /** Monotonically-increasing counter per node type — never resets on delete */
  nodeCounters: Record<string, number>;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (node: Node<NodeData>) => void;
  insertEdge: (edge: Edge) => void;
  removeEdgesForHandle: (nodeId: string, handleId: string) => void;
  updateNodeData: (id: string, data: Partial<NodeData>) => void;
  updateNodeSize: (id: string, width: number, height: number) => void;
  setIsRunning: (v: boolean) => void;
  toggleDebug: () => void;
}

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set) => ({
      nodes: [],
      edges: [],
      isRunning: false,
      debugMode: false,
      nodeCounters: {},

      onNodesChange: (changes) =>
        set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) as Node<NodeData>[] })),

      onEdgesChange: (changes) =>
        set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),

      onConnect: (connection) =>
        set((s) => ({
          edges: addEdge(
            { ...connection, animated: false, style: edgeStyle(connection.targetHandle) },
            s.edges
          ),
        })),

      /** Auto-assigns a human-readable label with counter, e.g. "Image #2" */
      addNode: (node) =>
        set((s) => {
          const type    = node.type ?? "unknown";
          const count   = (s.nodeCounters[type] ?? 0) + 1;
          const label   = getNodeLabel(type, count);
          return {
            nodes:        [...s.nodes, { ...node, data: { ...node.data, label } }],
            nodeCounters: { ...s.nodeCounters, [type]: count },
          };
        }),

      insertEdge: (edge) => set((s) => ({ edges: [...s.edges, edge] })),

      removeEdgesForHandle: (nodeId, handleId) =>
        set((s) => ({
          edges: s.edges.filter(
            (e) => !(e.target === nodeId && e.targetHandle === handleId)
          ),
        })),

      updateNodeData: (id, data) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...data } } : n
          ),
        })),

      updateNodeSize: (id, width, height) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? { ...n, width, height, style: { ...n.style, width, height } }
              : n
          ),
        })),

      setIsRunning: (v) => set({ isRunning: v }),
      toggleDebug:  () => set((s) => ({ debugMode: !s.debugMode })),
    }),
    {
      name: "ai-workflow",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        nodes:        s.nodes,
        edges:        s.edges,
        nodeCounters: s.nodeCounters,
      }),
    }
  )
);
