"use client";
import { useState } from "react";
import { api, ApiError, type Fulfilment } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import WhatsAppUpdates from "./WhatsAppUpdates";

// Plain status lines with their source; money detail only reaches the payer
export default function StatusTimeline({ taskId, token, f, onChanged }: { taskId: string; token: string; f: Fulfilment; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); onChanged(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not do that."); } finally { setBusy(false); }
  };
  const m = f.money;
  return (
    <section className="card stack" aria-labelledby="st-h">
      <h2 id="st-h">{f.arrival ? `Arrives ${f.arrival}` : "Order status"}</h2>
      <ol className="timeline">
        {f.done.map((e, i) => (
          <li key={i} className="done"><strong>{e.text}</strong>
            <span className="muted small"> · {new Date(e.at).toLocaleDateString("en-KE", { day: "numeric", month: "short" })} · {e.source}</span>
            {e.note && <span className="small"> {e.note}</span>}</li>
        ))}
        {f.next.map((t, i) => <li key={`n${i}`} className="next muted">{t}</li>)}
      </ol>
      {m?.extraDueMinor && !m.extraDecision && (
        <div className="note stack">
          <p>The provider&apos;s final bill is {formatMoney(m.extraDueMinor, m.currency)} above the cap you paid. Approve the extra, or decline and we will sort it out with you.</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => act(() => api.decideExtra(taskId, token, "approved"))}>Approve the extra</button>
            <button className="btn secondary" disabled={busy} onClick={() => act(() => api.decideExtra(taskId, token, "declined"))}>Decline</button>
          </div>
        </div>
      )}
      {m && <p className="muted small">Paid up to {formatMoney(m.capMinor, m.currency)}{m.actualMinor ? `; final cost ${formatMoney(m.actualMinor, m.currency)}` : ""}. {m.concierge}</p>}
      {f.canCancel && (
        <button className="btn secondary" disabled={busy} onClick={() => { if (confirm("Cancel and get a full refund?")) void act(() => api.cancelOrder(taskId, token)); }}>
          Cancel for a full refund
        </button>
      )}
      <WhatsAppUpdates taskId={taskId} token={token} />
      <p role="alert" className="error">{err}</p>
    </section>
  );
}
