import { Suspense } from "react";
import TaskPage from "@/components/TaskView";

async function Inner({ params }: { params: PageProps<"/t/[id]">["params"] }) {
  const { id } = await params;
  return <TaskPage taskId={id} />;
}

export default function Page({ params }: PageProps<"/t/[id]">) {
  return <Suspense fallback={<main className="page"><p role="status">Opening...</p></main>}><Inner params={params} /></Suspense>;
}
