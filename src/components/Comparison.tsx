"use client";
import { useState } from "react";
import type { Offer } from "@/lib/api";
import { deliveryText, eligibilityLabel, formatMoney, sourceLabel, variantText } from "@/lib/format";

interface Props {
  offers: Offer[];
  canChoose: boolean;
  busyId: string | null;
  disabled: boolean;
  onChoose: (o: Offer) => void;
}

function Card({ o, canChoose, busyId, disabled, onChoose }: { o: Offer } & Omit<Props, "offers">) {
  const reasons = o.checks.filter((c) => o.status === "eligible" ? c.result === "match" : c.result !== "match");
  return (
    <li className={`offer ${o.status}`}>
      <div className="offer-head">
        <h3>{o.title}</h3>
        <span className={`badge ${o.status}`}>{eligibilityLabel(o.status)}</span>
      </div>
      <p className="seller">{o.seller}{variantText(o.variant) ? ` · ${variantText(o.variant)}` : ""}</p>
      <p className="price">{formatMoney(o.priceMinor, o.currency)}</p>
      <p className="muted">{deliveryText(o.shippingMinor, o.currency)} · {o.availability === "InStock" ? "In stock" : o.availability}</p>
      <p className="small"><span className="tag">{sourceLabel(o.route)}</span></p>
      {o.status === "unchecked" && <p className="small">Tell us what matters to check these.</p>}
      {o.status === "unresolved" && <p className="small">Not verified against what you need.</p>}
      {reasons.length > 0 && (
        <ul className="reasons">{reasons.map((c, i) => <li key={i}>{c.reason}</li>)}</ul>
      )}
      {canChoose && (o.status === "eligible" || o.status === "unchecked") && (
        <button className="btn" disabled={disabled || busyId !== null} onClick={() => onChoose(o)}>
          {busyId === o.id ? "Choosing..." : o.route === "external" ? "Choose this one (buy at retailer)" : "Choose this one"}
        </button>
      )}
    </li>
  );
}

export default function Comparison(props: Props) {
  const [more, setMore] = useState(false);
  const live = props.offers.filter((o) => o.status !== "ineligible");
  const out = props.offers.filter((o) => o.status === "ineligible");
  const shown = more ? live : live.slice(0, 3);
  return (
    <section className="card stack" aria-labelledby="cmp-h">
      <h2 id="cmp-h">Options</h2>
      {props.offers.length === 0 && <p className="muted">Options appear once we know what you need.</p>}
      <ul className="offers">
        {shown.map((o) => <Card key={o.id} o={o} {...props} />)}
      </ul>
      {live.length > 3 && (
        <button className="btn secondary" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "Show fewer" : `More options (${live.length - 3})`}
        </button>
      )}
      {out.length > 0 && (
        <details className="excluded">
          <summary>Doesn&apos;t match ({out.length})</summary>
          <ul className="offers">{out.map((o) => <Card key={o.id} o={o} {...props} />)}</ul>
        </details>
      )}
    </section>
  );
}
