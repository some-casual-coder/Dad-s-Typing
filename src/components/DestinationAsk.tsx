"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

type Dest = { county: string; area: string; confirmed: boolean } | null;
const label = (d: { county: string; area: string }) => (d.area && d.area !== d.county ? `${d.area}, ${d.county}` : d.county);

// One question with a default; once answered it becomes a quiet "Change" link
export default function DestinationAsk({ taskId, token, dest, canEdit, onChanged }:
  { taskId: string; token: string; dest: Dest; canEdit: boolean; onChanged: () => void }) {
  const [other, setOther] = useState(false);
  const [place, setPlace] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: { confirm?: boolean; place?: string }) {
    setBusy(true); setErr("");
    try { await api.setDestination(taskId, token, body); setOther(false); setPlace(""); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }

  if (dest?.confirmed && !other) {
    return (
      <p className="small">Delivering to <strong>{label(dest)}</strong>
        {canEdit && <> · <button type="button" className="linkish" onClick={() => setOther(true)}>Change</button></>}</p>
    );
  }
  if (!canEdit) return <p className="small muted">Where to deliver is not set yet.</p>;
  return (
    <div className="stack ask">
      {!other ? (
        <>
          <p><strong>Deliver to {dest ? label(dest) : "Nairobi"}?</strong></p>
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => send({ confirm: true })}>Yes</button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => setOther(true)}>Somewhere else</button>
          </div>
        </>
      ) : (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (place.trim()) void send({ place }); }}>
          <label className="field"><span>Town or area in Kenya</span>
            <input value={place} maxLength={80} autoFocus onChange={(e) => setPlace(e.target.value)} placeholder="e.g. Kisumu, or Kilimani" /></label>
          <button type="submit" className="btn" disabled={busy || !place.trim()}>Save</button>
        </form>
      )}
      {err && <p role="alert" className="error">{err}</p>}
    </div>
  );
}
