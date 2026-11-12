export type CostStatus = "known" | "estimated" | "included" | "unknown" | "not_applicable";
export type Provider = "aquantuo" | "kentex";
export type Mode = "self_buy" | "buy_for_me" | "amazon_buy_ship" | "forwarding";
export type Handling = "pickup" | "door";

export interface Component {
  key: "item" | "domestic" | "freight" | "customs" | "buy_fee" | "kenya_delivery";
  label: string;
  status: CostStatus;
  currency: string;
  // Minor units; for an unknown cost lowMinor is only a known floor
  minor?: number;
  lowMinor?: number;
  highMinor?: number;
  note?: string;
  source: string;
  asOf: string;
}

export interface Parcel {
  // Which US warehouse the retailer ships from, when known
  hub?: "texas" | "delaware";
  weightGrams?: number;
  // Packed box, millimetres
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
}

export interface Destination {
  country: "KE";
  county: string;
  city: string;
}

export interface Prefs {
  handling: Handling;
  budgetKesMinor?: number;
  // Whether the budget already covers delivery to the door
  budgetIncludesDelivery?: boolean;
}

export interface OfferInput {
  id: string;
  title: string;
  seller: string;
  route: "paypal" | "external";
  priceMinor: number;
  shippingMinor: number | null;
  currency: string;
  url: string | null;
  exact: boolean;
}

export interface ImportedQuote {
  id: string;
  offerId: string;
  provider: Provider | "store";
  mode: Mode | "direct";
  reference: string;
  amountMinor: number;
  currency: string;
  // What the provider says the amount covers
  includesItem: boolean;
  includesCustoms: boolean;
  includesDelivery: boolean;
  expiresAt: string | null;
}

export interface Handoff {
  officialUrl: string;
  fields: { label: string; value: string }[];
  steps: string[];
  // Details the provider form needs that we do not have yet
  missing: string[];
}

export type RouteKind = "local" | "direct" | "forward";
export type Availability = "available" | "ineligible" | "needs_quote";

export interface Plan {
  id: string;
  offerId: string;
  route: RouteKind;
  provider: Provider | "store" | "demo";
  mode: Mode | "direct" | "local";
  title: string;
  exact: boolean;
  availability: Availability;
  why: string;
  components: Component[];
  complete: boolean;
  // Priced parts in one currency; null when none is priced or currencies differ
  knownMinor: number | null;
  knownHighMinor: number | null;
  knownCurrency: string | null;
  // Priced parts converted at indicative rates; a total only when complete
  kes: { low: number; high: number } | null;
  underBudget: "yes" | "no" | "unknown";
  quote: { reference: string; expired: boolean; expiresAt: string | null } | null;
  handoff: Handoff | null;
  payments: string;
}
