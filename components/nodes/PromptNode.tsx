"use client";
import { useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";

type PromptNodeType = Node<NodeData, "promptNode">;

export default function PromptNode({ id, data }: NodeProps<PromptNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  return (
    <div className="relative" style={{ width: 260 }}>
      {/* Floating label — above the frame, not part of it */}
      <span className="node-above-label">Text</span>

      <div className="node-card">
        {/* Inner wrapper clips content to rounded corners */}
        <div className="overflow-hidden rounded-[7px] px-3 py-2.5">
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent text-[12px] text-[#c0c0c0] leading-[1.6] resize-none outline-none placeholder-[#333] overflow-hidden"
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
