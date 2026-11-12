"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

type Dest = { county: string; area: string; confirmed: boolean; handling: "pickup" | "door" } | null;
const label = (d: { county: string; area: string }) =>
  !d.area || d.area === d.county ? d.county : d.area.includes(d.county) ? d.area : `${d.area}, ${d.county}`;

// Pickup in Nairobi is the default; a place is asked only for door delivery
export default function DestinationAsk({ taskId, token, dest, canEdit, onChanged }:
  { taskId: string; token: string; dest: Dest; canEdit: boolean; onChanged: () => void }) {
  const [door, setDoor] = useState(false);
  const [place, setPlace] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: { confirm?: boolean; place?: string; handling?: "pickup" | "door" }) {
    setBusy(true); setErr("");
    try { await api.setDestination(taskId, token, body); setDoor(false); setPlace(""); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }

  const link = (text: string, fn: () => void) => <button type="button" className="linkish" disabled={busy} onClick={fn}>{text}</button>;
  let body;
  if (door) {
    body = (
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (place.trim()) void send({ place, handling: "door" }); }}>
        <label className="field"><span>Town or area to deliver to</span>
          <input value={place} maxLength={80} autoFocus onChange={(e) => setPlace(e.target.value)} placeholder="e.g. Kisumu, or Kilimani" /></label>
        <button type="submit" className="btn" disabled={busy || !place.trim()}>Save</button>
        {link("Cancel", () => setDoor(false))}
      </form>
    );
  } else if (dest?.confirmed && dest.handling === "door") {
    body = <p className="small">Delivering to your door in <strong>{label(dest)}</strong>
      {canEdit && <> · {link("Collect instead", () => send({ handling: "pickup", confirm: true }))} · {link("Change", () => setDoor(true))}</>}</p>;
  } else {
    // Pickup is the default, stated, not asked; door delivery is one tap
    body = <p className="small">Collect in <strong>Nairobi</strong>, no extra cost
      {canEdit && <> · {link("Deliver to my door", () => setDoor(true))}</>}</p>;
  }
  return <>{body}{err && <p role="alert" className="error">{err}</p>}</>;
}
