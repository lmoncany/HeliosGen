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
  imageUrl?: string;            // generated or piped output
  inputImage?: string;          // base64 dataURL or remote URL set by user
  imageNaturalRatio?: string;   // CSS aspect-ratio of the uploaded image, e.g. "1920 / 1080"
  // generation settings
  quality?: string;             // "1k" | "2k" | "4k"
  // video output
  videoUrl?: string;
  // error message
  errorMsg?: string;
  // pending job
  taskId?: string;
}

interface WorkflowStore {
  nodes: Node<NodeData>[];
  edges: Edge[];
  isRunning: boolean;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (node: Node<NodeData>) => void;
  insertEdge: (edge: Edge) => void;
  removeEdgesForHandle: (nodeId: string, handleId: string) => void;
  updateNodeData: (id: string, data: Partial<NodeData>) => void;
  setIsRunning: (v: boolean) => void;
}

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set) => ({
      nodes: [],
      edges: [],
      isRunning: false,

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

      addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),

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

      setIsRunning: (v) => set({ isRunning: v }),
    }),
    {
      name: "ai-workflow",
      storage: createJSONStorage(() => localStorage),
      // Only persist graph state — isRunning always resets to false on load
      partialize: (s) => ({ nodes: s.nodes, edges: s.edges }),
    }
  )
);
