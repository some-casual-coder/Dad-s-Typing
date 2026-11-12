"use client";
import { useState, type ReactNode } from "react";
import { api, ApiError, type Fulfilment, type Notice } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import WhatsAppUpdates from "./WhatsAppUpdates";

const when = (iso: string) => new Date(iso).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function NoticeItem({ n }: { n: Notice }) {
  return (
    <li className="notice">
      <p>{n.body}</p>
      {(n.place?.mapsUrl || n.contact) && (
        <p className="small">
          {n.place?.mapsUrl && <a href={n.place.mapsUrl} target="_blank" rel="noopener noreferrer">Open the map{n.place.pin?.approximate ? " (approximate)" : ""}</a>}
          {n.place?.mapsUrl && n.contact && " · "}
          {n.contact && <a href={`tel:${n.contact.phone}`}>Call {n.contact.name}</a>}
        </p>
      )}
      <p className="muted small">{when(n.at)}</p>
    </li>
  );
}

// Track: the date and where it is now first, the newest message open, the
// rest one tap away. Money detail only reaches someone who can pay.
export default function StatusTimeline({ taskId, token, f, onChanged, extra }: { taskId: string; token: string; f: Fulfilment; onChanged: () => void; extra?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); onChanged(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not do that."); } finally { setBusy(false); }
  };
  const m = f.money;
  const now = f.done.at(-1);
  const latest = f.notices.at(-1);
  const older = f.notices.slice(0, -1);
  return (
    <section className="card stack" aria-labelledby="st-h">
      <h2 id="st-h">{f.arrival ? `Arrives ${f.arrival}` : "Order status"}</h2>
      {now && <p role="status"><strong>{now.text}</strong><span className="muted small"> · {now.source}</span></p>}
      {f.next[0] && <p className="small muted">Next: {f.next[0]}</p>}
      {latest && <ul className="notices"><NoticeItem n={latest} /></ul>}
      {m?.extraDueMinor && !m.extraDecision && (
        <div className="note stack">
          <p>The provider&apos;s final bill is {formatMoney(m.extraDueMinor, m.currency)} above the cap you paid. Approve and pay the extra, or decline and we will sort it out with you.</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => act(() => api.decideExtra(taskId, token, "approved"))}>Approve the extra</button>
            <button className="btn secondary" disabled={busy} onClick={() => act(() => api.decideExtra(taskId, token, "declined"))}>Decline</button>
          </div>
        </div>
      )}
      {extra}
      <details className="more">
        <summary>All updates ({f.done.length + f.notices.length})</summary>
        <ol className="timeline">
          {f.done.map((e, i) => (
            <li key={i} className="done"><strong>{e.text}</strong>
              <span className="muted small"> · {new Date(e.at).toLocaleDateString("en-KE", { day: "numeric", month: "short" })} · {e.source}</span>
              {e.note && <span className="small"> {e.note}</span>}</li>
          ))}
          {f.next.map((t, i) => <li key={`n${i}`} className="next muted">{t}</li>)}
        </ol>
        {older.length > 0 && <ul className="notices">{[...older].reverse().map((n, i) => <NoticeItem key={i} n={n} />)}</ul>}
      </details>
      <details className="more">
        <summary>More</summary>
        <div className="stack">
          {m && <p className="muted small">Paid up to {formatMoney(m.capMinor, m.currency)}{m.actualMinor ? `; final cost ${formatMoney(m.actualMinor, m.currency)}` : ""}. {m.concierge}</p>}
          <WhatsAppUpdates taskId={taskId} token={token} />
          {f.canCancel && (
            <button className="linkish" disabled={busy} onClick={() => { if (confirm("Cancel and get a full refund?")) void act(() => api.cancelOrder(taskId, token)); }}>
              Cancel for a full refund
            </button>
          )}
        </div>
      </details>
      <p role="alert" className="error">{err}</p>
    </section>
  );
}
