// Arrival date range from legs, each with its source. Dates are calendar
// days in Nairobi time. Kenyan public holidays are not modelled yet.
export interface Leg { label: string; low: number; high: number; unit: "working" | "calendar"; source: string; assumed: boolean }
export interface Eta { earliest: string; latest: string; legs: Leg[]; assumptions: string[]; confidence: "medium" | "low" }

export type Lane = "kentex_amazon" | "kentex_store" | "aquantuo_uk" | "aquantuo_us" | "local_demo";
export type Area = "nairobi" | "upcountry" | "unknown";

const DAY = 86_400_000;
const EAT_MS = 3 * 3600_000;

// Midnight UTC of the Nairobi calendar date, so arithmetic ignores time zones
export const nairobiDate = (now: Date) => new Date(Math.floor((now.getTime() + EAT_MS) / DAY) * DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const weekday = (d: Date) => d.getUTCDay();

export function addWorkingDays(d: Date, n: number): Date {
  let out = d, left = n;
  while (left > 0) {
    out = addDays(out, 1);
    if (weekday(out) !== 0 && weekday(out) !== 6) left--;
  }
  return out;
}

const add = (d: Date, l: Leg, end: "low" | "high") => (l.unit === "working" ? addWorkingDays(d, l[end]) : addDays(d, l[end]));

// Kentex air leaves Wednesday; parcels must be in by Monday (P). The fast
// case makes a Monday arrival; the slow case assumes it misses it.
export function kentexDeparture(atWarehouse: Date, end: "low" | "high"): Date {
  let monday = atWarehouse;
  while (weekday(monday) !== 1) monday = addDays(monday, 1);
  if (end === "high" && iso(monday) === iso(atWarehouse)) monday = addDays(monday, 7);
  return addDays(monday, 2);
}

const KENTEX_AIR = "kentexcargo.com/help/air-shipping-kenya (P)";
const KENTEX_AMAZON = "kentexcargo.com/help/amazon-shopping (P)";

function legs(lane: Lane, area: Area, handling: "pickup" | "door"): Leg[] {
  const last: Leg = handling === "pickup"
    ? { label: "Ready to collect in Nairobi", low: 0, high: 1, unit: "working", source: "Our assumption (M)", assumed: true }
    : area === "nairobi"
      ? { label: "Delivery to your door in Nairobi", low: 1, high: 2, unit: "working", source: "Our assumption (M)", assumed: true }
      : { label: area === "upcountry" ? "Delivery to your door outside Nairobi" : "Delivery to your door", low: 1, high: 4, unit: "working", source: "Our assumption (M)", assumed: true };
  switch (lane) {
    case "kentex_amazon":
      return [{ label: "Amazon delivers to Kentex in Texas", low: 1, high: 4, unit: "working", source: `${KENTEX_AMAZON}; Prime timing assumed (M)`, assumed: true },
        { label: "Air freight to Kenya", low: 7, high: 14, unit: "working", source: KENTEX_AIR, assumed: false }, last];
    case "kentex_store":
      return [{ label: "Kentex quotes and buys it", low: 1, high: 2, unit: "working", source: "kentexcargo.com/help/usa/assisted-shopping, quote within 24 h (P)", assumed: false },
        { label: "The store delivers to Kentex in the US", low: 3, high: 7, unit: "working", source: "Typical US store delivery, assumed (M)", assumed: true },
        { label: "Air freight to Kenya", low: 7, high: 14, unit: "working", source: KENTEX_AIR, assumed: false }, last];
    case "aquantuo_uk":
      return [{ label: "Aquantuo buys, ships and clears it", low: 10, high: 15, unit: "working", source: "Aquantuo Kenya rate card, from payment (N)", assumed: false }, last];
    case "aquantuo_us":
      return [{ label: "Aquantuo buys, ships and clears it", low: 10, high: 21, unit: "working", source: "No published US time; UK figure widened (M)", assumed: true }, last];
    case "local_demo":
      return [{ label: "Seller delivers", low: 2, high: 5, unit: "working", source: "Demo seller, not a real promise", assumed: true }];
  }
}

export function estimateArrival(lane: Lane, now: Date, opts: { area?: Area; handling?: "pickup" | "door" } = {}): Eta {
  const ls = legs(lane, opts.area ?? "unknown", opts.handling ?? "door");
  const kentex = lane === "kentex_amazon" || lane === "kentex_store";
  const run = (end: "low" | "high") => {
    let d = nairobiDate(now);
    for (const l of ls) {
      // Freight counts from the Wednesday departure, the cautious reading
      if (kentex && l.label === "Air freight to Kenya") d = kentexDeparture(d, end);
      d = add(d, l, end);
    }
    return d;
  };
  const assumptions = [
    ...(kentex ? ["Kentex's 7 to 14 working days is counted from the Wednesday flight, not from ordering.", "Customs time is inside Kentex's transit range."] : []),
    "Kenyan public holidays are not counted.",
    ...ls.filter((l) => l.assumed).map((l) => `${l.label}: our estimate.`),
  ];
  const assumed = ls.filter((l) => l.assumed).length;
  return { earliest: iso(run("low")), latest: iso(run("high")), legs: ls, assumptions, confidence: assumed > 1 ? "low" : "medium" };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "about 2 to 9 December", or across months "about 28 November to 9 December"
export function formatRange(earliest: string, latest: string): string {
  const [a, b] = [new Date(`${earliest}T00:00:00Z`), new Date(`${latest}T00:00:00Z`)];
  const day = (d: Date) => d.getUTCDate(), mon = (d: Date) => MONTHS[d.getUTCMonth()];
  if (earliest === latest) return `about ${day(a)} ${mon(a)}`;
  if (a.getUTCMonth() === b.getUTCMonth()) return `about ${day(a)} to ${day(b)} ${mon(b)}`;
  return `about ${day(a)} ${mon(a)} to ${day(b)} ${mon(b)}`;
}
