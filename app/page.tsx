"use client";
import dynamic from "next/dynamic";
import Sidebar from "@/components/Sidebar";

// ReactFlow must be client-only (uses browser APIs)
const WorkflowCanvas = dynamic(() => import("@/components/WorkflowCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-gray-600">
      Loading canvas…
    </div>
  ),
});

export default function Home() {
  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar />
      <WorkflowCanvas />
    </div>
  );
}
