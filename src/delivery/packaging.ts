import type { OfferSpecs } from "@/adapters/types";

// Packed parcel estimate from item facts. Priors are hypotheses to calibrate
// against warehouse invoices (parcel_calibration), not measurements.
export type Basis = "measured" | "listed" | "weight_only" | "category";
export type Confidence = "high" | "medium" | "low";

export interface Box { grams: number; lengthMm: number; widthMm: number; heightMm: number }

export interface ParcelEstimate {
  basis: Basis;
  confidence: Confidence;
  kind: string;
  // low: repacked tightly by the forwarder; high: retail box plus cushioning
  low: Box;
  high: Box;
  note: string;
}

interface Prior {
  kind: string; match: RegExp; grams: number; dims: [number, number, number];
  // Packaging weight share and fixed pad; cushion per side in mm
  pack: number; padGrams: number; cushionMm: number;
  // Ships folded: the smallest side can collapse in the box (hypothesis)
  flatMm?: number;
}

// Order matters: first match wins
const PRIORS: Prior[] = [
  { kind: "crate", match: /\bcrates?\b|kennel/, grams: 9000, dims: [760, 480, 530], pack: 0.08, padGrams: 300, cushionMm: 20, flatMm: 100 },
  { kind: "pet carrier", match: /carrier|pet.?bag/, grams: 1500, dims: [450, 300, 300], pack: 0.12, padGrams: 150, cushionMm: 20 },
  { kind: "stroller", match: /stroller|pram|pushchair/, grams: 8000, dims: [850, 500, 300], pack: 0.1, padGrams: 400, cushionMm: 30 },
  { kind: "shoes", match: /shoe|sneaker|trainer|boot|sandal|footwear/, grams: 900, dims: [330, 220, 120], pack: 0.15, padGrams: 50, cushionMm: 10 },
  { kind: "bag", match: /handbag|backpack|\bbags?\b|purse|tote|luggage/, grams: 800, dims: [350, 150, 280], pack: 0.1, padGrams: 50, cushionMm: 10 },
  { kind: "clothing", match: /shirt|dress|jacket|coat|trouser|jean|sweater|hoodie|clothing|apparel|skirt/, grams: 450, dims: [300, 250, 50], pack: 0.08, padGrams: 40, cushionMm: 5 },
  { kind: "small appliance", match: /kettle|fryer|blender|toaster|mixer|appliance|microwave|coffee/, grams: 3500, dims: [350, 300, 350], pack: 0.2, padGrams: 300, cushionMm: 50 },
  { kind: "small electronics", match: /headphone|earbud|earphone|speaker|phone|tablet|camera|watch|electronic/, grams: 400, dims: [200, 180, 80], pack: 0.25, padGrams: 150, cushionMm: 50 },
  { kind: "toy", match: /\btoys?\b|lego|doll|puzzle|game/, grams: 800, dims: [300, 250, 150], pack: 0.15, padGrams: 100, cushionMm: 20 },
];
const DEFAULT: Prior = { kind: "general item", match: /$^/, grams: 1500, dims: [350, 250, 200], pack: 0.15, padGrams: 150, cushionMm: 30 };

const norm = (t: string) => t.toLowerCase().replace(/-/g, " ");

// The title names the item; the category is only a fallback
export function priorFor(title: string, category: string[] = []): Prior {
  const t = norm(title), c = norm(category.join(" "));
  return PRIORS.find((p) => p.match.test(t)) ?? PRIORS.find((p) => p.match.test(c)) ?? DEFAULT;
}

const sorted = (d: [number, number, number]) => [...d].sort((a, b) => b - a) as [number, number, number];
const box = (grams: number, d: [number, number, number]): Box => {
  const [l, w, h] = sorted(d).map((x) => Math.max(10, Math.round(x)));
  return { grams: Math.max(50, Math.round(grams)), lengthMm: l, widthMm: w, heightMm: h };
};

// Scale prior dims to a known weight, assuming similar density
const scaledDims = (p: Prior, grams: number): [number, number, number] => {
  const f = Math.cbrt(grams / p.grams);
  return p.dims.map((x) => x * f) as [number, number, number];
};

export function estimateParcel(item: { title: string; specs?: OfferSpecs }, measured?: Partial<Box>): ParcelEstimate {
  const s = item.specs ?? {};
  const p = priorFor(item.title, s.category);
  if (measured?.grams && measured.lengthMm && measured.widthMm && measured.heightMm) {
    const b = box(measured.grams, [measured.lengthMm, measured.widthMm, measured.heightMm]);
    return { basis: "measured", confidence: "high", kind: p.kind, low: b, high: b, note: "Packed weight and box entered from a measurement." };
  }
  const dims = s.lengthMm && s.widthMm && s.heightMm ? ([s.lengthMm, s.widthMm, s.heightMm] as [number, number, number]) : null;
  const basis: Basis = s.weightGrams && dims ? "listed" : s.weightGrams ? "weight_only" : "category";
  // Spread around the item weight: listed figures are tight, priors are wide
  const spread = basis === "category" ? [0.6, 1.6] : [0.97, 1.05];
  const g = s.weightGrams ?? p.grams;
  const d = dims ?? (s.weightGrams ? scaledDims(p, s.weightGrams) : p.dims);
  const dimSpread = dims ? [1, 1] : basis === "weight_only" ? [0.85, 1.2] : [0.75, 1.3];
  const c = p.cushionMm;
  const lowDims = d.map((x) => x * dimSpread[0] + 10) as [number, number, number];
  if (p.flatMm) lowDims.sort((a, b) => b - a).splice(2, 1, Math.min(lowDims[2], p.flatMm));
  const low = box(g * spread[0] * (1 + p.pack / 2) + p.padGrams / 2, lowDims);
  const high = box(g * spread[1] * (1 + p.pack) + p.padGrams, d.map((x) => x * dimSpread[1] + 2 * c) as [number, number, number]);
  const confidence: Confidence = basis === "listed" ? "medium" : basis === "weight_only" ? "medium" : "low";
  const what = basis === "listed" ? "the seller's listed weight and size" : basis === "weight_only" ? "the seller's listed weight and a typical size"
    : `a typical ${p.kind}`;
  return { basis, confidence, kind: p.kind, low, high, note: `Packed parcel estimated from ${what}, plus packaging.` };
}

const CM3_PER_IN3 = 16.387064;

// Chargeable kg = max(actual, volume / divisor); divisor in cm3 per kg
export function chargeableKg(b: Box, cm3PerKg: number): number {
  const vol = (b.lengthMm / 10) * (b.widthMm / 10) * (b.heightMm / 10) / cm3PerKg;
  return Math.max(b.grams / 1000, vol);
}

export const KENTEX_CM3_PER_KG = 306 * CM3_PER_IN3;
// Industry norm, not published by Aquantuo: a hypothesis
export const AQUANTUO_CM3_PER_KG = 5000;
