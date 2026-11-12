"use client";
import { formatRange } from "@/delivery/eta";
import { useCallback, useEffect, useState } from "react";
import type { Component, Plan } from "@/delivery/types";
import { STEP_LABELS, stepsFor, type Step } from "@/delivery/steps";
import { api, ApiError, type DeliveryInputs, type DeliveryView } from "@/lib/api";
import { formatMoney } from "@/lib/format";

const STATUS_TEXT: Record<Component["status"], string> = {
  known: "Known", estimated: "Estimated", included: "Included", unknown: "Unknown", not_applicable: "Not applicable",
};
const num = (v: string) => (v.trim() === "" ? null : Number(v));
const cm = (mm: number | null) => (mm ? String(mm / 10) : "");

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn secondary small-btn" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { setDone(false); }
    }}>{done ? "Copied" : "Copy"}</button>
  );
}

function amount(p: Plan) {
  if (p.complete && p.kes) {
    const kes = p.kes.low === p.kes.high ? formatMoney(p.kes.low, "KES") : `${formatMoney(p.kes.low, "KES")} to ${formatMoney(p.kes.high, "KES")}`;
    const own = p.knownMinor !== null && p.knownCurrency
      ? ` (${p.knownMinor === p.knownHighMinor ? formatMoney(p.knownMinor, p.knownCurrency) : `${formatMoney(p.knownMinor, p.knownCurrency)} to ${formatMoney(p.knownHighMinor, p.knownCurrency)}`})` : "";
    return `${kes}${own}`;
  }
  return null;
}

function PlanCard({ p, winner, v, taskId, token, canEdit, onChanged }: {
  p: Plan; winner: boolean; v: DeliveryView; taskId: string; token: string; canEdit: boolean; onChanged: () => void;
}) {
  const total = amount(p);
  const prog = v.progress.find((x) => x.planId === p.id);
  const steps = p.route === "forward" ? stepsFor(p.mode) : null;
  const [err, setErr] = useState("");
  const [q, setQ] = useState({ reference: "", amount: "", currency: "USD", item: false, customs: false, delivery: false, expires: "" });

  async function run(fn: () => Promise<unknown>) {
    setErr("");
    try { await fn(); onChanged(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save."); }
  }
  const saveQuote = () => run(() => {
    const major = Number(q.amount);
    if (!q.reference.trim() || !Number.isFinite(major) || major < 0) throw new ApiError(0, "invalid", "Enter the quote reference and amount.");
    return api.addQuote(taskId, token, { offerId: p.offerId, provider: p.provider, mode: p.mode, reference: q.reference.trim(),
      amountMinor: Math.round(major * 100), currency: q.currency.toUpperCase(), includesItem: q.item, includesCustoms: q.customs,
      includesDelivery: q.delivery, expiresAt: q.expires ? new Date(q.expires).toISOString() : null });
  });

  return (
    <li className={`offer ${winner ? "eligible" : ""}`}>
      <div className="offer-head">
        <h3>{p.title}</h3>
        <span className={`badge ${winner ? "eligible" : "unresolved"}`}>
          {winner ? "Cheapest delivered" : p.availability === "ineligible" ? "Not available" : p.complete ? "Estimated total" : "Incomplete"}
        </span>
      </div>
      <p className="seller">{p.provider === "demo" ? "Demo seller" : p.provider === "store" ? "Direct from the store" : p.provider === "aquantuo" ? "Aquantuo" : "Kentex"}{p.exact ? "" : " · similar or unverified item"}</p>
      {total ? <p className="price">{total}</p> : <p className="muted">Not a total yet. Some costs are unknown.</p>}
      {p.eta && <p className="small">Arrives {formatRange(p.eta.earliest, p.eta.latest)}</p>}
      <p className="small">{p.why}</p>
      {p.availability !== "ineligible" && (
        <ul className="reasons">
          {p.components.map((c, i) => (
            <li key={i}><strong>{STATUS_TEXT[c.status]}</strong> · {c.label}
              {c.minor !== undefined && c.status !== "included" ? `: ${formatMoney(c.minor, c.currency)}${c.highMinor ? ` to ${formatMoney(c.highMinor, c.currency)}` : ""}` : ""}
              {c.minor === undefined && c.lowMinor ? `: at least ${formatMoney(c.lowMinor, c.currency)}` : ""}
              {c.note ? <span className="muted"> {c.note}</span> : null}</li>
          ))}
        </ul>
      )}
      {p.underBudget !== "unknown" && <p className="small">{p.underBudget === "yes" ? "Within your budget." : "Over your budget."}</p>}
      {p.availability !== "ineligible" && <p className="small muted">{p.payments}</p>}
      {p.quote && <p className="small">Quote {p.quote.reference}{p.quote.expired ? " has expired." : p.quote.expiresAt ? ` valid until ${new Date(p.quote.expiresAt).toLocaleDateString()}.` : "."}</p>}

      {p.handoff && (
        <details>
          <summary>How to do this</summary>
          <div className="stack">
            {p.handoff.missing.length > 0 && <p className="note">Still needed: {p.handoff.missing.join(", ")}.</p>}
            <ol>{p.handoff.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            <a className="btn secondary" href={p.handoff.officialUrl} target="_blank" rel="noopener noreferrer">Open the provider&apos;s page</a>
            <ul className="reasons">
              {p.handoff.fields.map((f, i) => <li key={i}><span className="muted">{f.label}:</span> {f.value} <Copy text={f.value} /></li>)}
            </ul>
            <p className="small muted">A quote or a link is not a payment, a purchase or a shipment. You finish on the provider&apos;s site.</p>
          </div>
        </details>
      )}

      {canEdit && (p.provider === "store" || p.handoff) && (
        <details>
          <summary>I have a quote</summary>
          <div className="stack">
            <label className="field"><span>Quote reference</span><input value={q.reference} maxLength={80} onChange={(e) => setQ({ ...q, reference: e.target.value })} /></label>
            <div className="row">
              <label className="field"><span>Amount</span><input inputMode="decimal" value={q.amount} onChange={(e) => setQ({ ...q, amount: e.target.value })} /></label>
              <label className="field"><span>Currency</span><input value={q.currency} maxLength={3} onChange={(e) => setQ({ ...q, currency: e.target.value })} /></label>
              <label className="field"><span>Valid until</span><input type="date" value={q.expires} onChange={(e) => setQ({ ...q, expires: e.target.value })} /></label>
            </div>
            <label><input type="checkbox" checked={q.item} onChange={(e) => setQ({ ...q, item: e.target.checked })} /> The quote includes the item price</label>
            <label><input type="checkbox" checked={q.customs} onChange={(e) => setQ({ ...q, customs: e.target.checked })} /> It says duties and taxes are included</label>
            <label><input type="checkbox" checked={q.delivery} onChange={(e) => setQ({ ...q, delivery: e.target.checked })} /> It includes delivery in Kenya</label>
            <button className="btn" type="button" onClick={saveQuote}>Add this quote</button>
          </div>
        </details>
      )}

      {steps && (
        <details open={!!prog}>
          <summary>Where is it? (you update this)</summary>
          <ul className="reasons">
            {steps.map((s: Step) => {
              const done = prog?.done.includes(s) ?? false;
              return (
                <li key={s}>{done ? "Done · " : ""}{STEP_LABELS[s]}{!done && canEdit &&
                  <> <button type="button" className="btn secondary small-btn"
                    onClick={() => run(() => api.markStep(taskId, token, { offerId: p.offerId, provider: p.provider, mode: p.mode, step: s }))}>Mark done</button></>}</li>
              );
            })}
          </ul>
          <p className="small">{prog ? `Next: ${prog.next.text}` : "Nothing marked yet. These are your notes, not provider confirmations."}</p>
        </details>
      )}
      <p role="alert" className="error">{err}</p>
    </li>
  );
}

export default function Delivery({ taskId, token, canEdit, refreshKey }: { taskId: string; token: string; canEdit: boolean; refreshKey: number }) {
  const [v, setV] = useState<DeliveryView | null>(null);
  const [f, setF] = useState<DeliveryInputs | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try { const d = await api.getDelivery(taskId, token); setV(d); setF((cur) => cur ?? d.input); } catch { setErr("Could not load delivery options."); }
  }, [taskId, token]);
  useEffect(() => {
    const run = async () => { await load(); };
    void run();
  }, [load, refreshKey]);

  if (!v || !f) return err ? <p role="alert" className="error">{err}</p> : null;
  const external = v.plans.some((p) => p.route !== "local");
  if (!external && v.plans.length === 0) return null;
  const set = <K extends keyof DeliveryInputs>(k: K, val: DeliveryInputs[K]) => setF({ ...f, [k]: val });

  async function save() {
    setMsg(""); setErr("");
    try { await api.saveDelivery(taskId, token, f!); setMsg("Saved."); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save."); }
  }

  const avail = v.plans.filter((p) => p.availability !== "ineligible");
  const gone = v.plans.filter((p) => p.availability === "ineligible");
  const order = (a: Plan, b: Plan) => Number(b.id === v.cheapestId) - Number(a.id === v.cheapestId) || Number(b.complete) - Number(a.complete) || (a.kes?.high ?? 9e15) - (b.kes?.high ?? 9e15);
  const exact = avail.filter((p) => p.exact).sort(order);
  const similar = avail.filter((p) => !p.exact).sort(order);
  // Cheapest of each route first, so six local offers cannot bury the import routes
  const top = (ps: Plan[]) => {
    const seen = new Map<string, number>();
    const head: Plan[] = [], rest: Plan[] = [];
    for (const p of ps) {
      const k = `${p.provider}:${p.mode}`;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      (n < 1 ? head : rest).push(p);
    }
    return { head, rest };
  };
  const card = (p: Plan) => <PlanCard key={p.id} p={p} winner={p.id === v.cheapestId} v={v} taskId={taskId} token={token} canEdit={canEdit} onChanged={load} />;

  return (
    <section className="card stack" aria-labelledby="dlv-h">
      <h2 id="dlv-h">Getting it to Kenya</h2>
      <p className="muted">Compare buying here with buying abroad. Costs marked Unknown are not guessed, and an incomplete total never wins.</p>
      {canEdit && (
        <div className="stack">
          <div className="row">
            <label className="field"><span>County</span><input value={f.county} maxLength={80} onChange={(e) => set("county", e.target.value)} placeholder="Nairobi" /></label>
            <label className="field"><span>City or area</span><input value={f.city} maxLength={80} onChange={(e) => set("city", e.target.value)} placeholder="Westlands" /></label>
          </div>
          <div className="row">
            <label><input type="radio" name="handling" checked={f.handling === "door"} onChange={() => set("handling", "door")} /> Deliver to me</label>
            <label><input type="radio" name="handling" checked={f.handling === "pickup"} onChange={() => set("handling", "pickup")} /> I will collect</label>
          </div>
          <div className="row">
            <label className="field"><span>Budget (KES)</span><input inputMode="numeric" value={f.budgetKesMinor ? String(f.budgetKesMinor / 100) : ""}
              onChange={(e) => { const n = num(e.target.value); set("budgetKesMinor", n === null || !Number.isFinite(n) ? null : Math.round(n * 100)); }} /></label>
            <label><input type="checkbox" checked={f.budgetIncludesDelivery === true} onChange={(e) => set("budgetIncludesDelivery", e.target.checked)} /> Budget includes delivery</label>
          </div>
          <details>
            <summary>Packed parcel (improves the estimate)</summary>
            <div className="row">
              <label className="field"><span>Weight (kg)</span><input inputMode="decimal" value={f.weightGrams ? String(f.weightGrams / 1000) : ""}
                onChange={(e) => { const n = num(e.target.value); set("weightGrams", n && n > 0 ? Math.round(n * 1000) : null); }} /></label>
              {(["lengthMm", "widthMm", "heightMm"] as const).map((k) => (
                <label className="field" key={k}><span>{k === "lengthMm" ? "Length" : k === "widthMm" ? "Width" : "Height"} (cm)</span>
                  <input inputMode="decimal" value={cm(f[k])} onChange={(e) => { const n = num(e.target.value); set(k, n && n > 0 ? Math.round(n * 10) : null); }} /></label>
              ))}
              <label className="field"><span>Ships from (US)</span>
                <select value={f.hub ?? ""} onChange={(e) => set("hub", (e.target.value || null) as DeliveryInputs["hub"])}>
                  <option value="">Not sure</option><option value="texas">Texas</option><option value="delaware">Delaware</option>
                </select></label>
            </div>
          </details>
          <button className="btn" type="button" onClick={save}>Update comparison</button>
        </div>
      )}
      <p className="small muted">Rates dated {v.asOf}. {v.fxSource}. Not quotes.</p>
      {[["Exact matches", exact], ["Similar or not yet verified", similar]].map(([title, list]) => {
        const { head, rest } = top(list as Plan[]);
        return head.length > 0 && (
          <div className="stack" key={title as string}>
            <h3>{title as string}</h3>
            <ul className="offers">{head.map(card)}</ul>
            {rest.length > 0 && <details><summary>More options ({rest.length})</summary><ul className="offers">{rest.map(card)}</ul></details>}
          </div>
        );
      })}
      {gone.length > 0 && (
        <details className="excluded"><summary>Not available ({gone.length})</summary>
          <ul className="offers">{gone.map(card)}</ul></details>
      )}
      <p role="status" className="ok-note">{msg}</p>
      <p role="alert" className="error">{err}</p>
    </section>
  );
}
