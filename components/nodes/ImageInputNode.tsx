"use client";
import { useRef, useCallback, useState } from "react";
import { Handle, Position, NodeProps, Node, NodeResizer } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";

type ImageInputNodeType = Node<NodeData, "imageInputNode">;

const MAX_DISPLAY = 280; // max px for either dimension on first load

export default function ImageInputNode({ id, data, selected }: NodeProps<ImageInputNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const updateNodeSize = useWorkflowStore((s) => s.updateNodeSize);
  const fileRef        = useRef<HTMLInputElement>(null);

  const setImage = useCallback(
    (src: string) => {
      const img = new Image();
      img.onload = () => {
        const scale  = Math.min(MAX_DISPLAY / img.naturalWidth, MAX_DISPLAY / img.naturalHeight, 1);
        const w      = Math.round(img.naturalWidth  * scale);
        const h      = Math.round(img.naturalHeight * scale);
        updateNodeData(id, {
          inputImage: src,
          imageNaturalRatio: `${img.naturalWidth} / ${img.naturalHeight}`,
        });
        updateNodeSize(id, w, h);
      };
      img.src = src;
    },
    [id, updateNodeData, updateNodeSize]
  );

  const loadFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => setImage(e.target?.result as string);
      reader.readAsDataURL(file);
    },
    [setImage]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file?.type.startsWith("image/")) loadFile(file);
    },
    [loadFile]
  );

  const [hovered, setHovered] = useState(false);
  const hasImage = !!data.inputImage;
  const ratio    = (data.imageNaturalRatio as string | undefined) ?? "1 / 1";

  return (
    <div
      className="relative w-full h-full"
      style={!hasImage ? { minWidth: 240 } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <NodeResizer
        isVisible={selected || hovered}
        minWidth={120}
        minHeight={80}
        keepAspectRatio={hasImage}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, background: "#a78bfa", border: "none" }}
        lineStyle={{ borderColor: "#a78bfa", borderWidth: 1, opacity: 0.5 }}
      />
      {/* Floating label */}
      <span className="node-above-label">Image</span>

      <div className="node-card w-full h-full">
        <Handle type="source" position={Position.Right} className="node-handle node-handle-source" />

        {/* Inner wrapper — clips everything to the card's rounded corners */}
        <div className="overflow-hidden rounded-[7px] w-full h-full">
          {hasImage ? (
            <div className="relative group w-full h-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={data.inputImage as string}
                alt="Input"
                className="w-full h-full object-cover block"
                style={{ aspectRatio: ratio }}
              />
              {/* Hover controls */}
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
                <div className="absolute bottom-2 left-0 right-0 flex justify-between px-2.5">
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => fileRef.current?.click()}
                    className="text-[10px] text-[#aaa] hover:text-white transition-colors relative z-10"
                  >
                    replace
                  </button>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() =>
                      updateNodeData(id, { inputImage: undefined, imageNaturalRatio: undefined })
                    }
                    className="text-[10px] text-[#aaa] hover:text-white transition-colors relative z-10"
                  >
                    remove
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-2.5">
              <div
                onDrop={onDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileRef.current?.click()}
                className="border border-dashed border-[#252525] hover:border-[#333] rounded-md cursor-pointer transition-colors py-8 text-center"
              >
                <p className="text-[11px] text-[#383838]">
                  Drop image or{" "}
                  <span className="underline underline-offset-2 text-[#505050]">browse</span>
                </p>
              </div>
              <input
                type="text"
                className="node-input mt-2"
                placeholder="or paste image URL…"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v) setImage(v);
                }}
              />
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
        }}
      />
    </div>
  );
}
