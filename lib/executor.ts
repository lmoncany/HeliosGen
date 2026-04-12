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
): {
  prompt?: string;
  imageUrls: string[];
  startFrameUrl?: string;
  endFrameUrl?: string;
  resources: Array<{ url: string; label: string }>;
} {
  const incoming = edges.filter((e) => e.target === nodeId);
  const result = {
    imageUrls:    [] as string[],
    resources:    [] as Array<{ url: string; label: string }>,
    startFrameUrl: undefined as string | undefined,
    endFrameUrl:   undefined as string | undefined,
    prompt:        undefined as string | undefined,
  };

  for (const edge of incoming) {
    const src = nodes.find((n) => n.id === edge.source);
    if (!src) continue;

    // Prompt sources
    if (src.type === "promptNode") {
      result.prompt = src.data.prompt as string | undefined;
    }

    // "image" handle — multi-image input for generateNode (up to 14)
    if (edge.targetHandle === "image") {
      if (src.type === "imageInputNode" && src.data.inputImage) {
        result.imageUrls.push(src.data.inputImage as string);
      }
      if (src.type === "generateNode") {
        if (src.data.imageUrl) result.imageUrls.push(src.data.imageUrl as string);
        if (src.data.prompt && !result.prompt) result.prompt = src.data.prompt as string;
      }
    }

    // "startFrame" handle — Kling first frame
    if (edge.targetHandle === "startFrame") {
      const url = (src.data.inputImage ?? src.data.imageUrl) as string | undefined;
      if (url) result.startFrameUrl = url;
    }

    // "endFrame" handle — Kling last frame
    if (edge.targetHandle === "endFrame") {
      const url = (src.data.inputImage ?? src.data.imageUrl) as string | undefined;
      if (url) result.endFrameUrl = url;
    }

    // "resource" handle — Kling element references (max 3)
    if (edge.targetHandle === "resource") {
      const url   = (src.data.inputImage ?? src.data.imageUrl) as string | undefined;
      const label = src.data.label as string | undefined;
      if (url && result.resources.length < 3) {
        result.resources.push({ url, label: label ?? "element" });
      }
    }

    // Upstream video generator — carry its prompt downstream
    if (src.type === "videoGeneratorNode") {
      if (src.data.prompt && !result.prompt) result.prompt = src.data.prompt as string;
    }
  }
  return result;
}
