"use client";
import { useCallback, useEffect, useState } from "react";
import type { Card } from "@/delivery/present";
import type { Component, Plan } from "@/delivery/types";
import { api, type DeliveryView, type Offer } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import DestinationAsk from "./DestinationAsk";
import QuoteCapture from "./QuoteCapture";

const STATUS: Record<Component["status"], string> = {
  known: "Known", estimated: "Estimate", included: "Included", unknown: "Not confirmed", not_applicable: "Not needed",
};
const CONF: Record<Plan["confidence"], string> = { high: "Firm figures", medium: "Good estimate", low: "Rough estimate" };
const PROVIDER: Record<string, string> = { kentex: "Kentex", aquantuo: "Aquantuo", demo: "Demo seller", store: "The store" };

const amount = (c: Component) => c.minor === undefined || c.status === "included" ? ""
  : `: ${formatMoney(c.minor, c.currency)}${c.highMinor && c.highMinor !== c.minor ? ` to ${formatMoney(c.highMinor, c.currency)}` : ""}`;

function Details({ plan, others, plans, quote }: { plan: Plan; others: string[]; plans: Plan[]; quote?: React.ReactNode }) {
  const alt = others.map((id) => plans.find((p) => p.id === id)).filter((p): p is Plan => !!p);
  return (
    <details className="more">
      <summary>Details</summary>
      <div className="stack small">
        <p><strong>{plan.title}</strong> · {PROVIDER[plan.provider] ?? plan.provider} · {CONF[plan.confidence]}</p>
        <p className="muted">{plan.why} {plan.payments}</p>
        <ul className="parts">
          {plan.components.map((c, i) => (
            <li key={i}><strong>{STATUS[c.status]}</strong> · {c.label}{amount(c)}
              {c.note ? <span className="muted"> {c.note}</span> : null}
              <span className="muted"> Source: {c.source}.</span></li>
          ))}
        </ul>
        {plan.eta && (
          <ul className="parts">
            {plan.eta.legs.map((l, i) => <li key={i}>{l.label}: {l.low} to {l.high} {l.unit === "working" ? "working days" : "days"}<span className="muted"> ({l.source})</span></li>)}
          </ul>
        )}
        {plan.handoff && (
          <p><a href={plan.handoff.officialUrl} target="_blank" rel="noopener noreferrer">Provider page</a>
            {" · "}<a href={plan.handoff.trackingUrl} target="_blank" rel="noopener noreferrer">Provider tracking</a></p>
        )}
        {quote}
        {alt.length > 0 && (
          <div>
            <p><strong>Other ways to get this</strong></p>
            <ul className="parts">
              {alt.map((a) => (
                <li key={a.id}>{a.title} ({PROVIDER[a.provider] ?? a.provider}): {a.complete && a.kes
                  ? `${formatMoney(a.kes.low, "KES")} to ${formatMoney(a.kes.high, "KES")}` : "cost not confirmed"}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function CardView({ c, plans, canChoose, busy, onChoose, quote }: { c: Card; plans: Plan[]; canChoose: boolean; busy: string | null; onChoose: (offerId: string) => void; quote?: React.ReactNode }) {
  const plan = plans.find((p) => p.id === c.planId)!;
  return (
    <li className={`dcard${c.winner ? " winner" : ""}`}>
      <div className="dcard-top">
        {c.imageUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={c.imageUrl} alt="" width={72} height={72} loading="lazy" referrerPolicy="no-referrer" />
          : <div className="noimg" aria-hidden="true" />}
        <div className="dcard-main">
          <h4>{c.title}</h4>
          <p className="muted small">{c.seller}</p>
        </div>
      </div>
      {c.winner && <p className="badge eligible">Best delivered price</p>}
      <p className="price">{c.price ?? (plan.availability === "needs_quote" ? "Quote required" : "Delivery cost not confirmed")}</p>
      {c.arrival && <p>Arrives {c.arrival}</p>}
      <p className="small">{c.difference}</p>
      {canChoose && (
        <button className="btn" disabled={busy !== null} onClick={() => onChoose(c.offerId)}>
          {busy === c.offerId ? "Choosing..." : "Choose this one"}
        </button>
      )}
      <Details plan={plan} others={c.others} plans={plans} quote={quote} />
    </li>
  );
}

export default function DeliveredCards({ taskId, token, refreshKey, canEdit, canChoose, busy, onChoose, excluded }: {
  taskId: string; token: string; refreshKey: number; canEdit: boolean; canChoose: boolean; busy: string | null;
  onChoose: (offerId: string) => void; excluded: Offer[];
}) {
  const [v, setV] = useState<DeliveryView | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try { setV(await api.getDelivery(taskId, token)); setErr(""); } catch { setErr("Could not load delivered prices."); }
  }, [taskId, token]);
  useEffect(() => { void (async () => { await load(); })(); }, [load, refreshKey]);

  if (!v) return <section className="card"><p role="status" className="muted">{err || "Working out delivered prices..."}</p></section>;
  const { closest, similar, more, recommendation } = v.cards;
  const quoteFor = (c: Card) => {
    const p = v.plans.find((x) => x.id === c.planId);
    return canEdit && p && (p.provider === "kentex" || p.provider === "aquantuo")
      ? <QuoteCapture taskId={taskId} token={token} offerId={p.offerId} provider={p.provider} mode={String(p.mode)} onSaved={load} /> : undefined;
  };
  const list = (cs: Card[]) => <ul className="dcards">{cs.map((c) => <CardView key={c.planId} c={c} plans={v.plans} canChoose={canChoose} busy={busy} onChoose={onChoose} quote={quoteFor(c)} />)}</ul>;
  return (
    <section className="card stack" aria-labelledby="dc-h">
      <h2 id="dc-h">Delivered to Kenya</h2>
      <DestinationAsk taskId={taskId} token={token} dest={v.destination} canEdit={canEdit} onChanged={load} />
      {recommendation && <p className="lead">{recommendation}</p>}
      {closest.length === 0 && similar.length === 0 && <p className="muted">No options yet. They appear once we know what you need.</p>}
      {closest.length > 0 && <><h3>Closest match</h3>{list(closest)}</>}
      {similar.length > 0 && <><h3>Similar</h3>{list(similar)}</>}
      {more.length > 0 && <details className="more"><summary>More options ({more.length})</summary>{list(more)}</details>}
      {v.cards.blocked.length > 0 && (
        <details className="more"><summary>Can&apos;t be flown to Kenya ({v.cards.blocked.length})</summary>
          <ul className="small">{v.cards.blocked.map((b, i) => <li key={i}>{b.title}: {b.reason}</li>)}</ul></details>
      )}
      {excluded.length > 0 && (
        <details className="more"><summary>Doesn&apos;t match what you need ({excluded.length})</summary>
          <ul className="small">{excluded.map((o) => <li key={o.id}>{o.title} · {o.seller}</li>)}</ul></details>
      )}
      <p className="muted small">Prices in KSh are estimates at {v.fxSource}. Rates dated {v.asOf}.</p>
    </section>
  );
}
