import type { Attribute, Op } from "@/domain/eligibility";
import type { ObservedCapture } from "@/domain/payments";
import type { ObservedRefund } from "@/domain/refunds";

export class AdapterError extends Error {
  constructor(readonly kind: "timeout" | "rejected" | "unavailable", message: string) {
    super(message);
  }
}

export interface ProposedRequirement {
  key: string; op: Op; value: string | number; unit?: string; essential: boolean; quote: string;
}

export interface Interpretation {
  observations: { text: string; confidence: "low" | "medium" | "high" }[];
  proposedRequirements: ProposedRequirement[];
  clarification: string | null;
  reply: string;
  // short product name for catalogue search, when the buyer's item is clear
  item?: string;
}

export interface InterpretInput {
  text?: string;
  image?: { mime: string; base64: string };
  currentRequirements: { key: string; op: Op; value: string | number; unit?: string | null }[];
}

export interface Interpreter {
  interpret(input: InterpretInput): Promise<Interpretation>;
}

export interface ExternalOffer {
  source: "channel3"; sourceOfferId: string; route: "external"; seller: string; title: string;
  attributes: Record<string, Attribute>; unitPriceMinor: number; shippingMinor: null;
  currency: string; availability: "InStock" | "OutOfStock"; url: string;
}

export interface Discovery {
  search(q: { query: string; country: "US" | "GB"; limit: number }): Promise<ExternalOffer[]>;
}

export interface CreateOrderInput {
  requestId: string; referenceId: string; currency: string; totalMinor: number;
  itemMinor: number; shippingMinor: number; description: string; returnUrl: string; cancelUrl: string;
}

export interface Payments {
  createOrder(i: CreateOrderInput): Promise<{ paypalOrderId: string; approveUrl: string }>;
  capture(paypalOrderId: string, requestId: string): Promise<ObservedCapture>;
  getOrder(paypalOrderId: string): Promise<ObservedCapture>;
  // no amountMinor means a full refund (empty body, as documented)
  refundCapture(captureId: string, i: { amountMinor?: number; currency: string; requestId: string }): Promise<ObservedRefund>;
  getRefund(refundId: string): Promise<ObservedRefund>;
  getCapture(captureId: string): Promise<ObservedCaptureFact>;
  verifyWebhook(i: WebhookVerification): Promise<boolean>;
}

export interface ObservedCaptureFact { captureId: string; status: string; amountMinor?: number; currency?: string }

// Transmission headers plus the exact raw event text, forwarded to PayPal only
export interface WebhookVerification {
  transmissionId: string; transmissionTime: string; transmissionSig: string;
  certUrl: string; authAlgo: string; webhookId: string; rawEvent: string;
}

export type AudioFormat = "webm" | "ogg" | "m4a";

export interface Transcriber {
  transcribe(input: { audio: Uint8Array; format: AudioFormat }): Promise<{ text: string; language?: string }>;
}
