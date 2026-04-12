"use client";
import { useRef, useState } from "react";
import { Handle, Position, NodeProps, Node, NodeResizer } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";

type PromptNodeType = Node<NodeData, "promptNode">;

export default function PromptNode({ id, data, selected }: NodeProps<PromptNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const [hovered, setHovered] = useState(false);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  return (
    <div
      className="relative h-full"
      style={{ minWidth: 260 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <NodeResizer
        isVisible={selected || hovered}
        minWidth={200}
        minHeight={80}
        keepAspectRatio
        handleStyle={{ width: 8, height: 8, borderRadius: 2, background: "#a78bfa", border: "none" }}
        lineStyle={{ borderColor: "#a78bfa", borderWidth: 1, opacity: 0.5 }}
      />
      {/* Floating label — above the frame, not part of it */}
      <span className="node-above-label">Text</span>

      <div className="node-card h-full">
        {/* Inner wrapper clips content to rounded corners */}
        <div className="overflow-hidden rounded-[7px] px-3 py-2.5 h-full">
          <textarea
            ref={textareaRef}
            className="w-full h-full bg-transparent text-[12px] text-[#c0c0c0] leading-[1.6] resize-none outline-none placeholder-[#333] overflow-auto"
            style={{ minHeight: 80 }}
            placeholder="Describe what you want to generate…"
            value={(data.prompt as string) ?? ""}
            onChange={(e) => {
              updateNodeData(id, { prompt: e.target.value });
              autoResize();
            }}
            onFocus={autoResize}
          />
        </div>
        <Handle type="source" position={Position.Right} className="node-handle node-handle-source" />
      </div>
    </div>
  );
}
