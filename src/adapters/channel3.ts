import type { Attribute } from "@/domain/eligibility";
import { failFor, jsonOf, send } from "./http";
import { AdapterError, type Discovery, type ExternalOffer, type OfferSpecs } from "./types";

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

const MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const G: Record<string, number> = { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

function measure(d: unknown, table: Record<string, number>, max: number): number | undefined {
  if (!isObj(d) || typeof d.number !== "number" || typeof d.unit !== "string") return undefined;
  const f = table[d.unit];
  const v = f ? Math.round(d.number * f) : NaN;
  return Number.isFinite(v) && v > 0 && v <= max ? v : undefined;
}

// Offer dimensions are merchant-stated item facts, not a packed parcel
function specsOf(p: Record<string, unknown>, chosen: Record<string, unknown> | undefined): OfferSpecs {
  const out: OfferSpecs = {};
  const offers = (Array.isArray(p.offers) ? p.offers : []).filter(isObj);
  const withDims = [chosen, ...offers].find((o) => o && isObj(o.dimensions));
  const d = withDims?.dimensions as Record<string, unknown> | undefined;
  if (d) {
    const w = measure(d.weight, G, 200_000), l = measure(d.length, MM, 5000), wi = measure(d.width, MM, 5000), h = measure(d.height, MM, 5000);
    if (w) out.weightGrams = w;
    if (l && wi && h) Object.assign(out, { lengthMm: l, widthMm: wi, heightMm: h });
    if (w || (l && wi && h)) out.dimsSource = `Channel3 offer dimensions from ${withDims === chosen ? "this" : "another"} seller (item spec, unpacked)`;
  }
  const cat = isObj(p.category) && Array.isArray(p.category.path) ? p.category.path : [];
  const slugs = cat.flatMap((c) => (isObj(c) && typeof c.slug === "string" ? [c.slug.slice(0, 60)] : [])).slice(0, 8);
  if (isObj(p.category) && typeof p.category.slug === "string" && !slugs.includes(p.category.slug)) slugs.push(p.category.slug.slice(0, 60));
  if (slugs.length) out.category = slugs;
  const brand = Array.isArray(p.brands) && isObj(p.brands[0]) && typeof p.brands[0].name === "string" ? p.brands[0].name.slice(0, 80) : undefined;
  if (brand) out.brand = brand;
  const imgs = (Array.isArray(p.images) ? p.images : []).filter(isObj);
  const img = httpsUrl((imgs.find((i) => i.is_main_image) ?? imgs[0])?.url);
  if (img) out.imageUrl = img;
  return out;
}

export function mapProduct(p: unknown): ExternalOffer | null {
  if (!isObj(p) || typeof p.id !== "string" || typeof p.title !== "string" || !Array.isArray(p.offers)) return null;
  const valid = p.offers.filter(isObj).flatMap((o) => {
    const url = httpsUrl(o.url);
    const price = isObj(o.price) ? o.price : null;
    if (!url || !price || typeof price.price !== "number" || !Number.isFinite(price.price) || price.price < 0 || typeof price.currency !== "string") return [];
    return [{ raw: o, url, seller: typeof o.domain === "string" ? o.domain : "unknown", minor: Math.round(price.price * 100), currency: price.currency.toUpperCase(), stock: o.availability === "InStock" ? ("InStock" as const) : ("OutOfStock" as const) }];
  });
  const o = valid.find((x) => x.stock === "InStock") ?? valid[0];
  if (!o) return null;
  return {
    source: "channel3", sourceOfferId: p.id, route: "external", seller: o.seller, title: p.title.slice(0, 300),
    attributes: attributesOf(p.structured_attributes), unitPriceMinor: o.minor, shippingMinor: null,
    currency: o.currency, availability: o.stock, url: o.url, specs: specsOf(p, o.raw),
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
      body: JSON.stringify({ query: q.query, limit: q.limit, config: { country: q.country, weight_unit: "kg", length_unit: "cm" } }),
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
