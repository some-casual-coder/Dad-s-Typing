"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, getStoredToken } from "@/lib/api";

type S = "working" | "checking" | "paid" | "cancelled" | "flagged" | "error";

export default function ReturnView({ taskId }: { taskId: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const cancelled = sp.get("cancelled") === "1" || sp.get("cancel") === "1" || sp.get("cancel") === "true";
  const [s, setS] = useState<S>("working");
  const [msg, setMsg] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = getStoredToken(taskId);
    const orderRef = sp.get("token");
    if (!token || !orderRef) {
      /* eslint-disable react-hooks/set-state-in-effect -- sessionStorage is client-only */
      setS("error");
      setMsg("We could not find your payment here. Open the task link you were sent and check the status there.");
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    (async () => {
      try {
        if (cancelled) { await api.payCancel(taskId, token, orderRef); setS("cancelled"); }
        else {
          const r = await api.payCapture(taskId, token, orderRef);
          setS(r.flagged ? "flagged" : r.order.status === "paid" ? "paid" : "checking");
        }
        setTimeout(() => router.replace(`/t/${encodeURIComponent(taskId)}`), 2500);
      } catch (e) {
        setS("error"); setMsg(e instanceof Error ? e.message : "Something went wrong.");
      }
    })();
  }, [taskId, cancelled, router, sp]);

  const text: Record<S, [string, string]> = {
    working: ["Finishing up...", "Please wait. Do not close this page."],
    checking: ["Checking your payment", "PayPal is still confirming. The task page will show the result."],
    paid: ["Payment received", "Thank you. Taking you back to the task."],
    cancelled: ["Payment cancelled", "Nothing was charged. Taking you back to the task."],
    flagged: ["We need to double-check this payment", "Something did not match, so we are not marking it paid yet. The task page shows the status."],
    error: ["We could not finish this", msg],
  };
  return (
    <main className="page">
      <section className="card stack" role="status" aria-live="polite">
        <h1>{text[s][0]}</h1>
        <p>{text[s][1]}</p>
        <p className="muted small">Sandbox payment. No real money moves.</p>
        {s !== "working" && <Link className="btn" href={`/t/${encodeURIComponent(taskId)}`}>Back to the task</Link>}
      </section>
    </main>
  );
}
