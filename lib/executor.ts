import { Node, Edge } from "@xyflow/react";
import { NodeData } from "./store";

/** Topological sort — returns node ids in execution order */
export function topoSort(nodes: Node<NodeData>[], edges: Edge[]): string[] {
  const adj: Record<string, string[]> = {};
  const inDegree: Record<string, number> = {};

  for (const n of nodes) {
    adj[n.id] = [];
    inDegree[n.id] = 0;
  }
  for (const e of edges) {
    adj[e.source].push(e.target);
    inDegree[e.target] = (inDegree[e.target] || 0) + 1;
  }

  const queue = Object.entries(inDegree)
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  const order: string[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj[id]) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }
  return order;
}

/** Resolve upstream prompt + images for a target node */
export function resolveInputs(
  nodeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[]
): { prompt?: string; imageUrls: string[] } {
  const incoming = edges.filter((e) => e.target === nodeId);
  const result: { prompt?: string; imageUrls: string[] } = { imageUrls: [] };

  for (const edge of incoming) {
    const src = nodes.find((n) => n.id === edge.source);
    if (!src) continue;

    // Prompt sources
    if (src.type === "promptNode") {
      result.prompt = src.data.prompt;
    }

    // Image input sources — collect all (up to 14 enforced by isValidConnection)
    if (src.type === "imageInputNode" && src.data.inputImage) {
      result.imageUrls.push(src.data.inputImage as string);
    }

    // Upstream generate node — carry its output image and prompt
    if (src.type === "generateNode") {
      if (src.data.imageUrl) result.imageUrls.push(src.data.imageUrl as string);
      if (src.data.prompt && !result.prompt) result.prompt = src.data.prompt as string;
    }
  }
  return result;
}
