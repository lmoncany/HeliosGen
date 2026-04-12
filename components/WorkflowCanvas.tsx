"use client";
import { useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  SelectionMode,
  Panel,
  Node,
  NodeChange,
  Connection,
  Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useWorkflowStore, NodeData } from "@/lib/store";
import { topoSort, resolveInputs } from "@/lib/executor";

import PromptNode    from "./nodes/PromptNode";
import ImageInputNode from "./nodes/ImageInputNode";
import GenerateNode  from "./nodes/GenerateNode";

const nodeTypes = {
  promptNode:     PromptNode,
  imageInputNode: ImageInputNode,
  generateNode:   GenerateNode,
};

export default function WorkflowCanvas() {
  const {
    nodes, edges,
    onNodesChange: _onNodesChange, onEdgesChange, onConnect,
    updateNodeData, isRunning, setIsRunning,
  } = useWorkflowStore();

  // Intercept node deletions: when a generateNode is deleted, also delete
  // its paired locked prompt (deletable:false nodes are skipped by React Flow
  // normally, but we want them gone when their generator is removed).
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const removedGenIds = changes
      .filter((c): c is Extract<NodeChange, { type: "remove" }> => c.type === "remove")
      .map((c) => c.id)
      .filter((id) => nodes.find((n) => n.id === id)?.type === "generateNode");

    if (removedGenIds.length > 0) {
      const pairedPromptIds = edges
        .filter(
          (e) =>
            removedGenIds.includes(e.target) &&
            e.targetHandle === "prompt" &&
            e.deletable === false
        )
        .map((e) => e.source);

      if (pairedPromptIds.length > 0) {
        const extra: Extract<NodeChange, { type: "remove" }>[] =
          pairedPromptIds.map((id) => ({ type: "remove", id }));
        _onNodesChange([...changes, ...extra]);
        return;
      }
    }

    _onNodesChange(changes);
  }, [_onNodesChange, nodes, edges]);

  const [log, setLog] = useState<{ text: string; ok: boolean }[]>([]);

  const push = useCallback((text: string, ok = true) => {
    setLog((l) => [...l.slice(-60), { text, ok }]);
  }, []);

  // prompt handle: 1 connection max. image handle: up to 14 (nano-banana-2 limit).
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const target = nodes.find((n) => n.id === connection.target);
      if (target?.type === "generateNode") {
        if (connection.targetHandle === "prompt") {
          const taken = edges.some(
            (e) => e.target === connection.target && e.targetHandle === "prompt"
          );
          if (taken) return false;
        }
        if (connection.targetHandle === "image") {
          const count = edges.filter(
            (e) => e.target === connection.target && e.targetHandle === "image"
          ).length;
          if (count >= 14) return false;
        }
      }
      return true;
    },
    [nodes, edges]
  );

  const runAll = useCallback(async () => {
    setIsRunning(true);
    setLog([]);
    push("Running workflow…");

    const order = topoSort(nodes, edges);

    for (const nodeId of order) {
      const node = nodes.find((n) => n.id === nodeId) as Node<NodeData> | undefined;
      if (!node || node.type !== "generateNode") continue;

      const upstream    = resolveInputs(nodeId, nodes as Node<NodeData>[], edges);
      const prompt      = upstream.prompt;
      const imageUrls   = upstream.imageUrls;
      const aspectRatio = node.data.aspectRatio ?? "1:1";
      const quality     = node.data.quality ?? "1k";

      push(`[${node.id}] ${aspectRatio} · ${imageUrls.length} image(s)…`);
      updateNodeData(nodeId, { status: "running", imageUrl: undefined });

      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, imageUrls, model: node.data.model, aspectRatio, quality }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        updateNodeData(nodeId, { status: "done", imageUrl: data.imageUrl, videoUrl: data.videoUrl });
        push(`[${node.id}] done`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        updateNodeData(nodeId, { status: "error", errorMsg: msg });
        push(`[${node.id}] error: ${msg}`, false);
      }
    }

    push("Complete");
    setIsRunning(false);
  }, [nodes, edges, updateNodeData, setIsRunning, push]);

  const clear = useCallback(() => {
    useWorkflowStore.setState({ nodes: [], edges: [] });
    setLog([]);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        fitView
        colorMode="dark"
        className="flex-1"
        // Left-drag on canvas → selection rectangle
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        // Right-click drag → pan  (two-finger trackpad covered by panOnScroll)
        panOnDrag={[2]}
        panOnScroll
        defaultEdgeOptions={{
          animated: false,
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="#2a2a2a" />
        <Controls
          showInteractive={false}
          className="[&>button]:!bg-[#111] [&>button]:!border-[#222] [&>button]:!text-[#666] [&>button:hover]:!text-[#aaa]"
        />

        <Panel position="top-right" className="flex items-center gap-2 m-3">
          {nodes.length > 0 && (
            <button onClick={clear} disabled={isRunning} className="toolbar-btn">
              Clear
            </button>
          )}
          <button
            onClick={runAll}
            disabled={isRunning || !nodes.some((n) => n.type === "generateNode")}
            className="toolbar-btn-primary"
          >
            {isRunning ? (
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 border border-[#555] border-t-[#aaa] rounded-full animate-spin" />
                Running
              </span>
            ) : (
              "Run all"
            )}
          </button>
        </Panel>
      </ReactFlow>

      {log.length > 0 && (
        <div className="h-24 bg-[#080808] border-t border-[#181818] overflow-y-auto px-4 py-2 shrink-0">
          {log.map((l, i) => (
            <p key={i} className={`text-[11px] font-mono leading-5 ${l.ok ? "text-[#444]" : "text-red-700"}`}>
              {l.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
