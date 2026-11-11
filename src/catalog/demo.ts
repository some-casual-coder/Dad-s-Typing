import type { Attribute } from "@/domain/eligibility";
import { recordOffers } from "@/domain/tasks";
import { getDiscovery } from "@/adapters";
import { AdapterError } from "@/adapters/types";

// SYNTHETIC catalogue for sandbox demos. Not a real seller or real stock.
export const DEMO_SELLER = "Whisker & Co (demo)";
const SPEC = "demo spec sheet";

interface Sku { sku: string; title: string; opening?: "top" | "front" | "side"; lengthCm: number; priceMinor: number; shippingMinor: number; stock?: "OutOfStock" }

export const DEMO_SKUS: Sku[] = [
  { sku: "WC-TOP-45", title: "Whisker & Co Skylift top-opening carrier 45 cm", opening: "top", lengthCm: 45, priceMinor: 4900, shippingMinor: 800 },
  { sku: "WC-TOP-55", title: "Whisker & Co Skylift top-opening carrier 55 cm", opening: "top", lengthCm: 55, priceMinor: 6400, shippingMinor: 900 },
  { sku: "WC-FRONT-48", title: "Whisker & Co Doorway front-opening carrier 48 cm", opening: "front", lengthCm: 48, priceMinor: 3900, shippingMinor: 800 },
  { sku: "WC-SIDE-50", title: "Whisker & Co Sidestep side-opening carrier 50 cm", opening: "side", lengthCm: 50, priceMinor: 5400, shippingMinor: 800 },
  { sku: "WC-PLAIN-42", title: "Whisker & Co Basic travel carrier 42 cm", lengthCm: 42, priceMinor: 2900, shippingMinor: 700 },
  { sku: "WC-TOP-60", title: "Whisker & Co Skylift XL top-opening carrier 60 cm", opening: "top", lengthCm: 60, priceMinor: 7900, shippingMinor: 1000, stock: "OutOfStock" },
];

export async function seedDemoOffers(taskId: string, merchantId = process.env.PAYPAL_MERCHANT_ID) {
  if (!merchantId) throw new Error("PAYPAL_MERCHANT_ID is not set");
  await recordOffers(taskId, DEMO_SKUS.map((s) => {
    const attributes: Record<string, Attribute> = { internal_length_cm: { value: s.lengthCm, unit: "cm", source: SPEC } };
    if (s.opening) attributes.opening = { value: s.opening, source: SPEC };
    return {
      source: "demo", sourceOfferId: s.sku, route: "paypal" as const, seller: DEMO_SELLER, merchantId, sku: s.sku, title: s.title,
      attributes, unitPriceMinor: s.priceMinor, shippingMinor: s.shippingMinor, currency: "USD", availability: s.stock ?? "InStock",
    };
  }));
}

export async function seedExternalOffers(taskId: string, query: string, country: "US" | "GB" = "US") {
  try {
    const offers = await getDiscovery().search({ query, country, limit: 10 });
    await recordOffers(taskId, offers);
    return offers.length;
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    console.warn(`channel3 discovery skipped: ${e.kind}`);
    return 0;
  }
}
