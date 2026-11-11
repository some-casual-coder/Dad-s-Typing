import { toDecimalString } from "@/domain/money";

export type NextAction =
  | "waiting_for_input" | "ready_for_choice" | "awaiting_payer"
  | "checking_payment" | "paid" | "cancelled" | "buy_at_retailer";

export type Role = "requester" | "helper" | "chooser" | "payer";
type Action = "message" | "propose_requirement" | "confirm_requirement"
  | "choose" | "invite" | "review_order" | "pay";

// Mirrors ROLE_ACTIONS on the server; the server still enforces it
const ROLE_ACTIONS: Record<Role, Action[]> = {
  requester: ["message", "propose_requirement", "confirm_requirement", "choose", "invite"],
  helper: ["message", "propose_requirement", "invite"],
  chooser: ["message", "choose"],
  payer: ["review_order", "pay"],
};

export const canDo = (roles: Role[], a: Action) =>
  roles.some((r) => ROLE_ACTIONS[r]?.includes(a));

export const parseFragmentToken = (hash: string): string | null => {
  const m = /(?:^#|&)k=([^&]+)/.exec(hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
};

export const inviteLink = (origin: string, taskId: string, token: string) =>
  `${origin}/t/${encodeURIComponent(taskId)}#k=${encodeURIComponent(token)}`;

export const tokenKey = (taskId: string) => `dt:token:${taskId}`;

export function formatMoney(minor: number | null | undefined, currency: string): string {
  if (typeof minor !== "number") return "Not confirmed";
  try { return `${currency} ${toDecimalString(minor, currency)}`; }
  catch { return `${currency} ${minor}`; }
}

export const deliveryText = (shippingMinor: number | null | undefined, currency: string) =>
  typeof shippingMinor === "number"
    ? shippingMinor === 0 ? "Free delivery" : `Delivery ${formatMoney(shippingMinor, currency)}`
    : "Delivery not confirmed";

export function nextActionCopy(a: NextAction): { headline: string; detail: string } {
  switch (a) {
    case "waiting_for_input":
      return { headline: "Waiting for details", detail: "Tell us what you are looking for, or send a photo. Then we can find options." };
    case "ready_for_choice":
      return { headline: "Ready to choose", detail: "Options are ready. The person choosing can pick one that matches." };
    case "awaiting_payer":
      return { headline: "Waiting for the payer", detail: "A choice was made. The person paying needs to review and pay." };
    case "checking_payment":
      return { headline: "Checking the payment", detail: "We are confirming the payment with PayPal. This can take a moment." };
    case "paid":
      return { headline: "Paid", detail: "Payment is confirmed. The receipt is below." };
    case "cancelled":
      return { headline: "Cancelled", detail: "This task was cancelled. Nothing more will be charged." };
    case "buy_at_retailer":
      return { headline: "Buy at the retailer", detail: "This item is sold on the retailer's own site. Open it there to buy." };
  }
}

export type OfferStatus = "eligible" | "ineligible" | "unresolved" | "unchecked";

export const eligibilityLabel = (s: OfferStatus) =>
  s === "eligible" ? "Eligible" : s === "ineligible" ? "Doesn't match" : s === "unchecked" ? "Not checked yet" : "Unverified";

export const sourceLabel = (route: string) =>
  route === "external" ? "External retailer link" : "Demo seller (sandbox)";

export const requirementLabel = (r: { key: string; op?: string; value: unknown; unit?: string | null }) => {
  const ops: Record<string, string> = { eq: "", neq: "not ", lte: "at most ", gte: "at least " };
  const key = r.key.replace(/_/g, " ");
  return `${key}: ${ops[r.op ?? "eq"] ?? ""}${String(r.value)}${r.unit ? ` ${r.unit}` : ""}`;
};

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function variantText(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string" || typeof x === "number").join(", ");
  return "";
}
