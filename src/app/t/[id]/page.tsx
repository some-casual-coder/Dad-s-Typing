import type { Metadata } from "next";
import { Suspense } from "react";
import TaskPage from "@/components/TaskView";

// What a chat link preview or crawler sees: nothing about the task. The
// access token lives in the URL fragment, which is never sent to the server.
export const metadata: Metadata = {
  title: "Dad's Typing — Open a shopping task",
  description: "A private shopping task.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  openGraph: { title: "Dad's Typing — Open a shopping task", description: "A private shopping task." },
};

async function Inner({ params }: { params: PageProps<"/t/[id]">["params"] }) {
  const { id } = await params;
  return <TaskPage taskId={id} />;
}

export default function Page({ params }: PageProps<"/t/[id]">) {
  return <Suspense fallback={<main className="page"><p role="status">Opening...</p></main>}><Inner params={params} /></Suspense>;
}
