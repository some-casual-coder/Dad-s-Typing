import { Suspense } from "react";
import ReturnView from "@/components/ReturnView";

async function Inner({ params }: { params: PageProps<"/t/[id]/pay/return">["params"] }) {
  const { id } = await params;
  return <ReturnView taskId={id} />;
}

export default function Page({ params }: PageProps<"/t/[id]/pay/return">) {
  return <Suspense fallback={<main className="page"><p role="status">Finishing up...</p></main>}><Inner params={params} /></Suspense>;
}
