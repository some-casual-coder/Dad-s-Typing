import type { Extracted } from "@/delivery/extract";
import type { Cards } from "@/delivery/present";
import type { Plan } from "@/delivery/types";
import { newId, tokenKey, type NextAction, type OfferStatus, type Role } from "./format";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface Requirement {
  id: string; key: string; op: string; value: unknown; unit?: string | null;
  essential: boolean; status: "proposed" | "confirmed";
}
export interface ConciergeSummary {
  provider: string; capMinor: number; estimateMinor: number; rule: string; arrival: string | null;
  lines: { label: string; status: string; currency: string; minor: number | null; highMinor: number | null }[];
}
export interface Fulfilment {
  arrival: string | null; next: string[]; canCancel: boolean;
  done: { status: string; text: string; at: string; source: string; note?: string }[];
  money?: { capMinor: number; estimateMinor: number; actualMinor: number | null; extraDueMinor: number | null; extraDecision: string | null; currency: string; rule: string; concierge: string };
}
export interface OrderView {
  kind?: "merchant" | "concierge"; concierge?: ConciergeSummary | null;
  id: string; seller: string; sku: string; title: string; quantity: number;
  currency: string; itemMinor: number; shippingMinor: number | null; totalMinor: number; status: string;
  refundedMinor?: number; refundPendingMinor?: number;
}
export interface Receipt {
  seller: string; title: string; sku: string; currency: string; totalMinor: number; taskId: string;
  refundedMinor?: number; refundPendingMinor?: number;
}
export interface TaskView {
  id: string; title: string; purpose?: string | null; version: number; nextAction: NextAction;
  viewer: { roles: Role[] }; requirements: Requirement[];
  selection: { id: string; stale: boolean; title: string; seller: string; route: string; reason: string; chosenAt: string } | null;
  order: OrderView | null; receipt: Receipt | null; fulfilment: Fulfilment | null;
}
export interface Check { key: string; essential: boolean; result: "match" | "mismatch" | "unknown"; reason: string }
export interface Offer {
  id: string; title: string; seller: string; route: "paypal" | "external"; sku: string; variant?: unknown;
  priceMinor: number; shippingMinor: number | null; currency: string; availability: string;
  url: string | null; observedAt?: string; status: OfferStatus; checks: Check[];
}
export interface Comparison { version: number; offers: Offer[] }
export interface ChatMessage {
  id: string; role: "user" | "assistant"; author: string; body: string; hasImage: boolean; createdAt: string;
}
export interface Proposal {
  key: string; op: string; value: string | number; unit?: string; essential: boolean; quote: string;
}
export interface DeliveryInputs {
  county: string; city: string; handling: "pickup" | "door"; budgetKesMinor: number | null; budgetIncludesDelivery: boolean | null;
  weightGrams: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null; hub: "texas" | "delaware" | null;
}
export interface DeliveryView {
  input: DeliveryInputs; plans: Plan[]; cheapestId: string | null; cards: Cards; asOf: string; fxSource: string;
  destination: { county: string; area: string; source: string; confirmed: boolean; handling: "pickup" | "door" } | null; askDestination: boolean;
  progress: { planId: string; done: string[]; next: { step: string | null; text: string } }[];
}
export interface SendResult { messages: ChatMessage[]; proposals: Proposal[]; clarification: string | null }

export const getStoredToken = (taskId: string): string | null => {
  try { return sessionStorage.getItem(tokenKey(taskId)); } catch { return null; }
};
export const storeToken = (taskId: string, token: string) => {
  try { sessionStorage.setItem(tokenKey(taskId), token); } catch { /* private mode */ }
};

async function call<T>(
  method: string, path: string, opts: { token?: string | null; body?: unknown; idem?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (opts.idem) headers["Idempotency-Key"] = newId();
  let res: Response;
  try {
    res = await fetch(path, {
      method, headers, cache: "no-store",
      signal: opts.signal,
      body: opts.body === undefined ? undefined
        : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? "Something went wrong.");
  }
  return data as T;
}

const t = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

export const api = {
  createTask: (body: { title: string; starterRoles: Role[]; label?: string; seedExternal?: boolean }) =>
    call<{ taskId: string; token: string }>("POST", "/api/tasks", { body }),
  transcribe: (id: string, token: string, audio: Blob, signal?: AbortSignal) => {
    const body = new FormData();
    body.append("audio", audio, "recording");
    return call<{ text: string; language?: string }>("POST", `${t(id)}/transcribe`, { token, body, signal });
  },
  getTask: (id: string, token: string) => call<TaskView>("GET", t(id), { token }),
  getComparison: (id: string, token: string) => call<Comparison>("GET", `${t(id)}/comparison`, { token }),
  getDelivery: (id: string, token: string) => call<DeliveryView>("GET", `${t(id)}/delivery`, { token }),
  saveDelivery: (id: string, token: string, body: DeliveryInputs) => call<{ ok: true }>("PUT", `${t(id)}/delivery`, { token, body }),
  addQuote: (id: string, token: string, body: Record<string, unknown>) => call<{ ok: true }>("POST", `${t(id)}/delivery/quotes`, { token, body }),
  markStep: (id: string, token: string, body: Record<string, unknown>) => call<{ ok: true }>("POST", `${t(id)}/delivery/steps`, { token, body }),
  extractQuote: (id: string, token: string, body: { imageBase64: string; mime: string }) => call<Extracted>("POST", `${t(id)}/delivery/extract`, { token, body }),
  cancelOrder: (id: string, token: string) => call<{ ok: true }>("POST", `${t(id)}/order/cancel`, { token, body: {} }),
  decideExtra: (id: string, token: string, decision: "approved" | "declined") => call<{ ok: true }>("POST", `${t(id)}/order/extra`, { token, body: { decision } }),
  setDestination: (id: string, token: string, body: { confirm?: boolean; place?: string; handling?: "pickup" | "door" }) =>
    call<{ county: string; area: string }>("PUT", `${t(id)}/destination`, { token, body }),
  getMessages: (id: string, token: string) =>
    call<{ messages: ChatMessage[]; proposals: Proposal[] }>("GET", `${t(id)}/messages`, { token }),
  sendMessage: (id: string, token: string, body: {
    clientMessageId: string; text?: string; imageBase64?: string; mime?: string;
  }) => call<SendResult>("POST", `${t(id)}/messages`, { token, body }),
  setRequirement: (id: string, token: string, body: {
    key: string; op?: string; value: string | number; unit?: string; essential?: boolean;
  }) => call<{ requirementId: string; status: string; version: number }>(
    "POST", `${t(id)}/requirements`, { token, body, idem: true }),
  confirmRequirement: (id: string, token: string, rid: string) =>
    call<{ version: number }>("POST", `${t(id)}/requirements/${encodeURIComponent(rid)}/confirm`, { token }),
  createInvite: (id: string, token: string, roles: Role[], label?: string) =>
    call<{ grantId: string; token: string }>("POST", `${t(id)}/invites`, { token, body: { roles, label } }),
  select: (id: string, token: string, offerId: string, expectedVersion: number) =>
    call<{ selectionId: string }>("POST", `${t(id)}/selection`,
      { token, body: { offerId, expectedVersion }, idem: true }),
  createOrder: (id: string, token: string, selectionId: string) =>
    call<OrderView>("POST", `${t(id)}/order`, { token, body: { selectionId } }),
  payCreate: (id: string, token: string, orderId: string) =>
    call<{ attemptId: string; paypalOrderId: string; approveUrl: string }>(
      "POST", `${t(id)}/pay/create`, { token, body: { orderId } }),
  payCapture: (id: string, token: string, paypalOrderId: string) =>
    call<{ order: OrderView; flagged?: boolean; receipt?: Receipt }>(
      "POST", `${t(id)}/pay/capture`, { token, body: { paypalOrderId } }),
  payCancel: (id: string, token: string, paypalOrderId: string) =>
    call<{ order: OrderView }>("POST", `${t(id)}/pay/cancel`, { token, body: { paypalOrderId } }),
};
