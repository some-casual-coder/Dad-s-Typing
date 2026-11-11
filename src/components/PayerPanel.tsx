"use client";
import { useState } from "react";
import { api, type OrderView, type TaskView } from "@/lib/api";
import { formatMoney } from "@/lib/format";

interface Props { taskId: string; token: string; view: TaskView; onChanged: () => void }

export default function PayerPanel({ taskId, token, view, onChanged }: Props) {
  const [local, setLocal] = useState<OrderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const order = view.order ?? local;
  const sel = view.selection;

  async function review() {
    if (!sel) return;
    setBusy(true); setErr("");
    try { setLocal(await api.createOrder(taskId, token, sel.id)); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not prepare the order."); }
    finally { setBusy(false); }
  }

  async function pay() {
    if (!order) return;
    setBusy(true); setErr("");
    try {
      const r = await api.payCreate(taskId, token, order.id);
      const host = new URL(r.approveUrl).hostname;
      if (!/(^|\.)paypal\.com$/.test(host)) throw new Error("Unexpected PayPal address.");
      window.location.assign(r.approveUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start PayPal.");
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="pay-h">
      <h2 id="pay-h">Payer <span className="tag">Sandbox</span></h2>
      <p className="muted small">Sandbox payment: PayPal test mode and a demo shop. No real money moves.</p>
      {!sel && <p>Waiting for a choice. The payer panel opens once an option is chosen.</p>}
      {sel && sel.route !== "paypal" && <p>This item is bought at the retailer, so there is nothing to pay here.</p>}
      {sel && sel.route === "paypal" && !order && (
        <>
          <p>Chosen: <strong>{sel.title}</strong> from {sel.seller}.</p>
          <button className="btn" disabled={busy} onClick={review}>{busy ? "Preparing..." : "Review order"}</button>
        </>
      )}
      {order && (
        <>
          <dl className="facts">
            <dt>Item</dt><dd>{order.title}</dd>
            <dt>SKU</dt><dd>{order.sku}</dd>
            <dt>Seller</dt><dd>{order.seller}</dd>
            <dt>Quantity</dt><dd>{order.quantity}</dd>
            <dt>Item price</dt><dd>{formatMoney(order.itemMinor, order.currency)}</dd>
            <dt>Delivery</dt><dd>{formatMoney(order.shippingMinor, order.currency)}</dd>
            <dt>Total</dt><dd><strong>{formatMoney(order.totalMinor, order.currency)}</strong></dd>
          </dl>
          {order.status === "awaiting_payer" && (
            <button className="btn pay" disabled={busy} onClick={pay}>
              {busy ? "Opening PayPal..." : "Pay with PayPal (sandbox)"}
            </button>
          )}
          {order.status === "pending" && (
            <>
              <p role="status">Checking the payment with PayPal...</p>
              <button className="btn" disabled={busy} onClick={pay}>Not approved yet? Continue to PayPal</button>
            </>
          )}
          {order.status === "paid" && <p role="status">Paid.</p>}
          {!!order.refundedMinor && <p role="status">Refunded: {formatMoney(order.refundedMinor, order.currency)}</p>}
          {!!order.refundPendingMinor && <p role="status">Refund pending: {formatMoney(order.refundPendingMinor, order.currency)}</p>}
          {order.status === "failed" && <p className="error">The payment did not go through. You can review the order again.</p>}
        </>
      )}
      <p role="alert" className="error">{err}</p>
    </section>
  );
}
