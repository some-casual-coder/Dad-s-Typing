"use client";
import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";

interface Row {
  id: string; taskId: string; title: string; provider: string; mode: string; currency: string; capMinor: number; actualMinor: number | null;
  extraDueMinor: number | null; extraDecision: string | null; providerPaid: boolean; settled: boolean; lastStatus: string | null; url: string | null;
}
const STATUSES: [string, string][] = [["ordered", "Ordered from the store"], ["at_warehouse", "Arrived at the US warehouse"], ["departed", "On the plane"],
  ["cleared", "Cleared customs"], ["ready_to_collect", "Ready to collect"], ["out_for_delivery", "Out for delivery"], ["delivered", "Delivered or collected"],
  ["stock_out", "Store out of stock (refunds in full)"]];
const H = { "content-type": "application/json", "x-dt-operator": "1" };
const newKey = () => `console:${crypto.randomUUID()}`;

function OrderForm({ o, onDone }: { o: Row; onDone: () => void }) {
  const [status, setStatus] = useState("ordered");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"none" | "total" | "weight">("none");
  const [v, setV] = useState({ total: "", kg: "", l: "", w: "", h: "", source: "" });
  const [key, setKey] = useState(newKey);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true); setMsg("");
    const actual = mode === "total" ? { totalMinor: Math.round(Number(v.total) * 100), source: v.source }
      : mode === "weight" ? { grams: Math.round(Number(v.kg) * 1000), lengthMm: Math.round(Number(v.l) * 10), widthMm: Math.round(Number(v.w) * 10), heightMm: Math.round(Number(v.h) * 10), source: v.source }
      : undefined;
    const r = await fetch(`/api/operator/orders/${o.id}/events`, { method: "POST", headers: H, body: JSON.stringify({ status, note: note || undefined, actual, operationKey: key }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setMsg(r.status === 202 ? "Saved; the refund is being checked with PayPal." : "Saved."); setKey(newKey()); setNote(""); onDone(); }
    else setMsg(j?.error?.message ?? j?.message ?? "Could not save.");
  }
  const f = (k: keyof typeof v, label: string) => (
    <label className="field"><span>{label}</span><input inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></label>);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label className="field"><span>New status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
      <label className="field"><span>Note (optional, payer sees it)</span><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
      <label className="field"><span>Final cost from the provider</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="none">Not yet</option><option value="total">Their bill total (USD)</option><option value="weight">Weighed parcel</option></select></label>
      {mode === "total" && f("total", "Bill total, USD")}
      {mode === "weight" && <div className="row">{f("kg", "Weight, kg")}{f("l", "Length, cm")}{f("w", "Width, cm")}{f("h", "Height, cm")}</div>}
      {mode !== "none" && <label className="field"><span>Where this figure comes from</span>
        <input value={v.source} maxLength={120} placeholder="e.g. Kentex invoice KX-1234" onChange={(e) => setV({ ...v, source: e.target.value })} /></label>}
      <button className="btn" type="submit" disabled={busy}>{busy ? "Saving..." : "Record"}</button>
      {msg && <p role="status" className="small">{msg}</p>}
    </form>
  );
}

export default function OperatorConsole() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/operator/orders", { headers: H });
    if (r.status === 403 || r.status === 401) { setLocked(true); return; }
    setRows((await r.json()).orders); setLocked(false);
  }, []);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);

  async function unlock() {
    setErr("");
    const r = await fetch("/api/operator/session", { method: "POST", headers: H, body: JSON.stringify({ secret }) });
    setSecret("");
    if (r.ok) await load(); else setErr("Not allowed.");
  }

  return (
    <main className="page">
      <header className="stack"><p className="eyebrow">Dad&apos;s Typing · operator</p><h1>Import orders</h1>
        <p className="muted small">Sandbox. Record what the provider confirms; the payer and their chats are updated automatically.</p></header>
      {locked && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void unlock(); }}>
          <label className="field"><span>Operator secret</span><input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
          <button className="btn" type="submit">Unlock for 8 hours</button>
          {err && <p role="alert" className="error">{err}</p>}
        </form>
      )}
      {rows && rows.length === 0 && <p className="muted">No paid import orders.</p>}
      {rows?.map((o) => (
        <section key={o.id} className="card stack">
          <h2>{o.title}</h2>
          <p className="small">{o.provider === "kentex" ? "Kentex" : "Aquantuo"} · {o.mode} · paid up to {formatMoney(o.capMinor, o.currency)}
            {o.actualMinor !== null && <> · final {formatMoney(o.actualMinor, o.currency)}</>}</p>
          <p className="small">Last status: <strong>{o.lastStatus ?? "none"}</strong>{o.providerPaid ? " · provider paid" : ""}{o.settled ? " · settled" : ""}
            {o.extraDueMinor && <> · extra {formatMoney(o.extraDueMinor, o.currency)} {o.extraDecision ?? "awaiting payer"}</>}</p>
          {o.url && <a className="small" href={o.url} target="_blank" rel="noopener noreferrer">Open the listing to buy</a>}
          <details className="more"><summary>Record an update</summary><OrderForm o={o} onDone={load} /></details>
        </section>
      ))}
    </main>
  );
}
