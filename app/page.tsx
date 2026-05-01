"use client";
import dynamic from "next/dynamic";
import WorkflowDashboard from "@/components/WorkflowDashboard";
import { useWorkflowStore } from "@/lib/store";

const WorkflowCanvas = dynamic(() => import("@/components/WorkflowCanvas"), {
  ssr: false,
});

export default function Home() {
  const showDashboard = useWorkflowStore((s) => s.showDashboard);

  if (showDashboard) {
    return <WorkflowDashboard />;
  }

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
      <WorkflowCanvas />
    </div>
  );
}
