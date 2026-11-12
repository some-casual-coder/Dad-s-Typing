import type { Mode } from "./types";

// User-entered milestones. None of them is proof of payment or shipment.
export const STEP_LABELS = {
  quote_accepted: "Accepted the quote on the provider's site",
  warehouse_verified: "Checked the retailer accepts my warehouse address",
  purchased: "Bought it at the retailer",
  pre_alert: "Pre-alert created with retailer tracking",
  received_warehouse: "Provider received it at its warehouse",
  freight_invoice_paid: "Paid the final freight invoice",
  delivered_kenya: "Delivered in Kenya",
} as const;

export type Step = keyof typeof STEP_LABELS;
export const isStep = (s: unknown): s is Step => typeof s === "string" && s in STEP_LABELS;

export const STEPS_BY_MODE: Record<string, Step[]> = {
  self_buy: ["warehouse_verified", "purchased", "pre_alert", "received_warehouse", "freight_invoice_paid", "delivered_kenya"],
  forwarding: ["warehouse_verified", "purchased", "pre_alert", "received_warehouse", "freight_invoice_paid", "delivered_kenya"],
  buy_for_me: ["quote_accepted", "received_warehouse", "freight_invoice_paid", "delivered_kenya"],
  amazon_buy_ship: ["quote_accepted", "received_warehouse", "freight_invoice_paid", "delivered_kenya"],
};

export function stepsFor(mode: Mode | string): Step[] | null {
  return STEPS_BY_MODE[mode] ?? null;
}

const NEXT: Record<Step, string> = {
  quote_accepted: "Open the provider's site and review the quote.",
  warehouse_verified: "Read your warehouse address in your provider account and check the retailer accepts it.",
  purchased: "Buy it at the retailer and keep the order confirmation.",
  pre_alert: "Add the retailer's tracking to the provider as a pre-alert.",
  received_warehouse: "Wait for the provider to confirm it arrived at its warehouse.",
  freight_invoice_paid: "Pay the final freight invoice on the provider's site.",
  delivered_kenya: "Confirm when it reaches you.",
};

export function nextAction(mode: string, done: string[]): { step: Step | null; text: string } {
  const list = stepsFor(mode);
  if (!list) return { step: null, text: "" };
  const step = list.find((s) => !done.includes(s)) ?? null;
  return { step, text: step ? NEXT[step] : "All steps are marked done." };
}
