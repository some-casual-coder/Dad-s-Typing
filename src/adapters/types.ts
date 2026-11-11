import type { Attribute, Op } from "@/domain/eligibility";
import type { ObservedCapture } from "@/domain/payments";

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
}
