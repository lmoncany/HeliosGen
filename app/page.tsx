"use client";
import dynamic from "next/dynamic";
import Sidebar from "@/components/Sidebar";

const WorkflowCanvas = dynamic(() => import("@/components/WorkflowCanvas"), {
  ssr: false,
});

export default function Home() {
  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
      <Sidebar />
      <WorkflowCanvas />
    </div>
  );
}
