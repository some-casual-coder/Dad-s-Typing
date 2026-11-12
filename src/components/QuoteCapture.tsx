"use client";
import { useState } from "react";
import type { Extracted } from "@/delivery/extract";
import { api, ApiError } from "@/lib/api";

type Form = { reference: string; amount: string; currency: string; expires: string; item: boolean; customs: boolean; delivery: boolean };
const toForm = (x: Extracted): Form => ({
  reference: x.reference ?? "", amount: x.amountMinor !== null ? (x.amountMinor / 100).toFixed(2) : "", currency: x.currency ?? "USD",
  expires: x.expiresAt ? x.expiresAt.slice(0, 10) : "", item: !!x.includesItem, customs: !!x.includesCustoms, delivery: !!x.includesDelivery,
});

// A screenshot fills the fields; each one can be fixed without retyping the rest
export default function QuoteCapture({ taskId, token, offerId, provider, mode, onSaved }:
  { taskId: string; token: string; offerId: string; provider: string; mode: string; onSaved: () => void }) {
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((o) => (o ? { ...o, [k]: v } : o));

  async function read(file: File) {
    setBusy(true); setMsg("");
    try {
      const b64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.onerror = () => rej(new Error("Could not read the screenshot."));
        r.readAsDataURL(file);
      });
      setF(toForm(await api.extractQuote(taskId, token, { imageBase64: b64, mime: file.type })));
      setMsg("Check these against the screenshot, fix anything wrong, then save.");
    } catch (e) { setMsg(e instanceof ApiError || e instanceof Error ? e.message : "Could not read it."); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!f) return;
    const minor = Math.round(Number(f.amount) * 100);
    if (!f.reference.trim() || !Number.isFinite(minor) || minor <= 0) { setMsg("A reference and a total are needed."); return; }
    setBusy(true); setMsg("");
    try {
      await api.addQuote(taskId, token, { offerId, provider, mode, reference: f.reference.trim(), amountMinor: minor, currency: f.currency,
        includesItem: f.item, includesCustoms: f.customs, includesDelivery: f.delivery, expiresAt: f.expires ? `${f.expires}T23:59:59+03:00` : null });
      setF(null); setMsg("Saved. The price now uses this quote."); onSaved();
    } catch (e) { setMsg(e instanceof ApiError ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack small">
      <label className="btn secondary small-btn">
        {busy && !f ? "Reading..." : "Add a quote screenshot"}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy}
          onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; if (x) void read(x); }} />
      </label>
      {f && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="field"><span>Quote reference</span><input value={f.reference} maxLength={60} onChange={(e) => set("reference", e.target.value)} /></label>
          <div className="row">
            <label className="field"><span>Total</span><input inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value)} /></label>
            <label className="field"><span>Currency</span>
              <select value={f.currency} onChange={(e) => set("currency", e.target.value)}>{["USD", "GBP", "KES"].map((c) => <option key={c}>{c}</option>)}</select></label>
          </div>
          <label className="field"><span>Valid until</span><input type="date" value={f.expires} onChange={(e) => set("expires", e.target.value)} /></label>
          <label><input type="checkbox" checked={f.item} onChange={(e) => set("item", e.target.checked)} /> Includes the item price</label>
          <label><input type="checkbox" checked={f.customs} onChange={(e) => set("customs", e.target.checked)} /> Duties and taxes included</label>
          <label><input type="checkbox" checked={f.delivery} onChange={(e) => set("delivery", e.target.checked)} /> Delivery in Kenya included</label>
          <button className="btn" type="submit" disabled={busy}>Looks right, save</button>
        </form>
      )}
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}
