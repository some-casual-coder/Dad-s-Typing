import type { Attribute } from "@/domain/eligibility";
import { failFor, jsonOf, send } from "./http";
import { AdapterError, type Discovery, type ExternalOffer } from "./types";

const OPENING_KEY = /opening|entry|entrance|loading|access/i;
const OPENINGS = ["top", "front", "side"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function httpsUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// Only a structured field that explicitly names an opening is evidence
function attributesOf(sa: unknown): Record<string, Attribute> {
  const out: Record<string, Attribute> = {};
  if (!isObj(sa)) return out;
  for (const [k, v] of Object.entries(sa)) {
    if (!OPENING_KEY.test(k)) continue;
    const vals = (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase());
    const hit = OPENINGS.filter((o) => vals.some((x) => new RegExp(`\\b${o}\\b`).test(x)));
    if (hit.length === 1) out.opening = { value: hit[0], source: "Channel3 structured_attributes" };
  }
  return out;
}

export function mapProduct(p: unknown): ExternalOffer | null {
  if (!isObj(p) || typeof p.id !== "string" || typeof p.title !== "string" || !Array.isArray(p.offers)) return null;
  const valid = p.offers.filter(isObj).flatMap((o) => {
    const url = httpsUrl(o.url);
    const price = isObj(o.price) ? o.price : null;
    if (!url || !price || typeof price.price !== "number" || !Number.isFinite(price.price) || price.price < 0 || typeof price.currency !== "string") return [];
    return [{ url, seller: typeof o.domain === "string" ? o.domain : "unknown", minor: Math.round(price.price * 100), currency: price.currency.toUpperCase(), stock: o.availability === "InStock" ? ("InStock" as const) : ("OutOfStock" as const) }];
  });
  const o = valid.find((x) => x.stock === "InStock") ?? valid[0];
  if (!o) return null;
  return {
    source: "channel3", sourceOfferId: p.id, route: "external", seller: o.seller, title: p.title.slice(0, 300),
    attributes: attributesOf(p.structured_attributes), unitPriceMinor: o.minor, shippingMinor: null,
    currency: o.currency, availability: o.stock, url: o.url,
  };
}

export class Channel3Discovery implements Discovery {
  constructor(private apiKey: string) {
    if (!apiKey) throw new AdapterError("unavailable", "Channel3 is not configured");
  }

  async search(q: { query: string; country: "US" | "GB"; limit: number }): Promise<ExternalOffer[]> {
    if (q.country !== "US" && q.country !== "GB") throw new AdapterError("rejected", "unsupported country");
    const r = await send("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q.query, limit: q.limit, config: { country: q.country } }),
    });
    if (!r.ok) throw failFor(r.status, "Channel3");
    const j = await jsonOf(r, "Channel3");
    const products = isObj(j) && Array.isArray(j.products) ? j.products : [];
    return products.flatMap((p) => mapProduct(p) ?? []);
  }
}

export function channel3FromEnv(env = process.env): Discovery {
  return new Channel3Discovery(env.CHANNEL3_API_KEY ?? "");
}
