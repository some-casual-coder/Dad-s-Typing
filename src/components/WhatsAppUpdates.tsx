"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

// Opt in from your own phone: send the code, get each step as a message
export default function WhatsAppUpdates({ taskId, token }: { taskId: string; token: string }) {
  const [j, setJ] = useState<{ code: string; whatsappLink: string | null } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function get() {
    setBusy(true); setErr("");
    try { setJ(await api.joinCode(taskId, token)); } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not make a code."); } finally { setBusy(false); }
  }
  if (!j) return (
    <div className="stack small">
      <button type="button" className="btn secondary small-btn" disabled={busy} onClick={get}>Get updates on WhatsApp</button>
      {err && <p role="alert" className="error">{err}</p>}
    </div>
  );
  return (
    <div className="stack small">
      {j.whatsappLink
        ? <a className="btn small-btn" href={j.whatsappLink} target="_blank" rel="noopener noreferrer">Open WhatsApp and send JOIN {j.code}</a>
        : <p>Send <strong>JOIN {j.code}</strong> to our WhatsApp number.</p>}
      <p className="muted">You&apos;ll get a message when it is paid, ordered, arrives and is ready to collect, with the pickup location. Reply STOP any time. The code works once, for 7 days.</p>
    </div>
  );
}
