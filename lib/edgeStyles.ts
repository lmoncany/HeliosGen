import type { CSSProperties } from "react";

// One colour per handle type so wires are instantly readable
export const EDGE_COLORS: Record<string, string> = {
  prompt:  "#a78bfa", // violet  — text / prompt
  image:   "#fb923c", // amber   — image input
  default: "#3a3a3a", // neutral — untyped / source-only
};

export function edgeStyle(targetHandle?: string | null): CSSProperties {
  const color = EDGE_COLORS[targetHandle ?? "default"] ?? EDGE_COLORS.default;
  return { stroke: color, strokeWidth: 2 };
}
