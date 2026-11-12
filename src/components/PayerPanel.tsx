"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type OrderPreview, type TaskView } from "@/lib/api";
import { formatMoney } from "@/lib/format";

interface Props { taskId: string; token: string; view: TaskView; onChanged: () => void }

const kes = (minor: number, micro?: number | null) =>
  micro ? `about KSh ${(Math.round((minor * micro) / 1e10) * 100).toLocaleString("en-KE")} at today's rate` : null;

// Pay: the exact charge is shown from a read-only preview; the order and the
// PayPal order are created only when the payer taps Pay, and only for the
// amount they saw. A changed total needs a fresh look.
export default function PayerPanel({ taskId, token, view, onChanged }: Props) {
  const [p, setP] = useState<OrderPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [changed, setChanged] = useState(false);
  const tapping = useRef(false);
  const sel = view.selection;
  const order = view.order;

  const load = useCallback(async () => {
    if (!sel || order) return;
    try { setP(await api.previewOrder(taskId, token)); setErr(""); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not work out the total."); }
  }, [taskId, token, sel, order]);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);

  async function goToPayPal(orderId: string) {
    const r = await api.payCreate(taskId, token, orderId);
    const host = new URL(r.approveUrl).hostname;
    if (!/(^|\.)paypal\.com$/.test(host)) throw new Error("Unexpected PayPal address.");
    window.location.assign(r.approveUrl);
  }

  async function pay() {
    if (tapping.current || !sel) return;
    tapping.current = true; setBusy(true); setErr("");
    try {
      const id = order?.id ?? (await api.createOrder(taskId, token, sel.id, p?.quote?.totalMinor)).id;
      await goToPayPal(id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale") { setChanged(true); await load(); onChanged(); }
      else setErr(e instanceof Error ? e.message : "Could not start PayPal.");
      tapping.current = false; setBusy(false);
    }
  }

  if (!sel) return null;
  const q = p?.quote;
  const total = order ? { minor: order.totalMinor, currency: order.currency } : q ? { minor: q.totalMinor, currency: q.currency } : null;
  const concierge = order ? order.kind === "concierge" : q?.kind === "concierge";
  const c = order?.concierge;
  const arrival = c?.arrival ?? q?.arrival ?? null;
  const lines = c?.lines ?? q?.lines;

  return (
    <section className="card stack pay" aria-labelledby="pay-h">
      <h2 id="pay-h">Pay <span className="tag">Sandbox</span></h2>
      <p><strong>{sel.title}</strong></p>
      <p className="small">From {concierge ? "Dad's Typing concierge (sandbox)" : order?.seller ?? q?.seller ?? sel.seller} · Quantity 1</p>
      {concierge && <p className="small">We buy it through {(c?.provider ?? q?.provider) === "aquantuo" ? "Aquantuo" : "Kentex"} and deliver it to you in Kenya.</p>}
      {arrival && <p>Arrives {arrival} <span className="muted small">(estimate)</span></p>}
      {lines && lines.length > 0 && (
        <div className="checkout">
          <p className="checkout-h">Costs</p>
          <dl className="costs">{lines.map((l, i) => (
            <div key={i} className="cost">
              <dt>{l.label}</dt>
              <dd>{l.status === "included" ? "Included" : l.minor !== null
                ? `${formatMoney(l.minor, l.currency)}${l.highMinor && l.highMinor !== l.minor ? ` to ${formatMoney(l.highMinor, l.currency)}` : ""}` : "To confirm"}</dd>
            </div>
          ))}</dl>
        </div>
      )}
      {total ? (
        <>
          <p className="price">{concierge ? "Up to " : "Total today: "}{formatMoney(total.minor, total.currency)}</p>
          {concierge && kes(total.minor, q?.kesPerUsdMicro) && <p className="small muted">{kes(total.minor, q?.kesPerUsdMicro)}</p>}
          {concierge && (
            <p className="small">Our estimate is {formatMoney(c?.estimateMinor ?? q?.estimateMinor ?? total.minor, total.currency)} to {formatMoney(total.minor, total.currency)}.
              {" "}{c?.rule ?? q?.rule}</p>
          )}
        </>
      ) : !err && !p?.changed && <p role="status" className="muted">Working out the total...</p>}
      {changed && <p className="note" role="alert">The total changed. Check it, then tap Pay again.</p>}
      {p?.changed && (
        <div className="note stack" role="alert">
          <p>{p.changed.toMinor !== null ? `The price changed since this was chosen. It's now ${formatMoney(p.changed.toMinor, p.changed.currency)}.` : "This item is no longer available at that price or is out of stock."}</p>
          {p.changed.toMinor !== null && (
            <button className="btn" disabled={busy} onClick={async () => {
              setBusy(true); setErr("");
              try { await api.select(taskId, token, p.changed!.offerId, view.version); setChanged(false); onChanged(); }
              catch (e) { setErr(e instanceof Error ? e.message : "Could not update."); } finally { setBusy(false); }
            }}>Review the new price</button>
          )}
        </div>
      )}
      <p className="small"><strong>{concierge ? "Sandbox demonstration: no real order or shipment is booked." : "Sandbox: demo shop, no real money moves."}</strong> PayPal charges in US dollars.</p>
      {total && !p?.changed && (!order || order.status === "awaiting_payer" || order.status === "failed") && (
        <button className="btn pay" disabled={busy} onClick={pay}>{busy ? "Opening PayPal..." : "Pay with PayPal (sandbox)"}</button>
      )}
      {order?.status === "pending" && (
        <>
          <p role="status">Checking the payment with PayPal...</p>
          <button className="btn secondary" disabled={busy} onClick={pay}>Not approved yet? Continue to PayPal</button>
        </>
      )}
      {order?.status === "failed" && <p className="error">The payment did not go through. You can try again.</p>}
      <p role="alert" className="error">{err}</p>
    </section>
  );
}

// An approved extra above the cap: one block to pay it, after payment
export function TopupPay({ taskId, token, view }: { taskId: string; token: string; view: TaskView }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const t = view.topup;
  if (!t) return null;
  if (t.status === "paid") return <p role="status" className="small">Extra paid: {formatMoney(t.totalMinor, t.currency)}.</p>;
  return (
    <div className="note stack">
      <p>You approved an extra {formatMoney(t.totalMinor, t.currency)} for the final shipping bill.</p>
      <button className="btn pay" disabled={busy} onClick={async () => {
        setBusy(true); setErr("");
        try {
          const r = await api.payCreate(taskId, token, t.id);
          if (!/(^|\.)paypal\.com$/.test(new URL(r.approveUrl).hostname)) throw new Error("Unexpected PayPal address.");
          window.location.assign(r.approveUrl);
        } catch (e) { setErr(e instanceof Error ? e.message : "Could not start PayPal."); setBusy(false); }
      }}>{busy ? "Opening PayPal..." : "Pay the extra with PayPal (sandbox)"}</button>
      <p role="alert" className="error">{err}</p>
    </div>
  );
}
