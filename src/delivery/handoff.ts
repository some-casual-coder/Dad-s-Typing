import { formatMoney } from "@/lib/format";
import { SOURCE_URLS } from "./rules";
import type { Destination, Handoff, Mode, OfferInput, Parcel, Prefs, Provider } from "./types";

const mm = (v?: number) => (v ? `${(v / 10).toFixed(1)} cm` : "");

function parcelFields(p: Parcel) {
  const f: { label: string; value: string }[] = [];
  if (p.weightGrams) f.push({ label: "Packed weight", value: `${(p.weightGrams / 1000).toFixed(2)} kg` });
  if (p.lengthMm && p.widthMm && p.heightMm)
    f.push({ label: "Packed box (L x W x H)", value: `${mm(p.lengthMm)} x ${mm(p.widthMm)} x ${mm(p.heightMm)}` });
  return f;
}

const WAREHOUSE = "Use the warehouse address from your own account page. Never copy one from a search result or a message.";

// Everything here is data to copy; the shopper submits on the provider's site
export function handoffFor(provider: Provider, mode: Mode, o: OfferInput, dest: Destination | null, parcel: Parcel, prefs: Prefs): Handoff {
  const urls = SOURCE_URLS[provider];
  const missing: string[] = [];
  const fields = [
    { label: "Item", value: o.title },
    ...(o.url ? [{ label: "Product link", value: o.url }] : []),
    { label: "Item price", value: formatMoney(o.priceMinor, o.currency) },
    { label: "Quantity", value: "1" },
    ...parcelFields(parcel),
    { label: "Delivery in Kenya", value: prefs.handling === "door" ? "To my door" : "I will collect" },
  ];
  if (dest?.county) fields.push({ label: "County", value: dest.county });
  if (dest?.city) fields.push({ label: "City or area", value: dest.city });
  // The public estimator needs both before it shows a price; its first 0 is a placeholder
  if (provider === "aquantuo") {
    if (!dest?.county) missing.push("County or state in Kenya");
    if (!dest?.city) missing.push("City or area in Kenya");
  }
  if (!parcel.weightGrams) missing.push("Packed weight");
  if (!(parcel.lengthMm && parcel.widthMm && parcel.heightMm)) missing.push("Packed box size");

  const steps: string[] = [];
  if (provider === "aquantuo" && mode === "self_buy") {
    steps.push("Open the Aquantuo estimator and enter the details above. A first price of 0 is a placeholder, not a rate.",
      "Sign in to your own Aquantuo account and read your warehouse address there.", WAREHOUSE,
      "Check the retailer accepts that address at checkout, then buy and pay the retailer yourself.",
      "Add the retailer tracking and proof of purchase in your Aquantuo account.",
      "Wait for the final freight invoice and pay it to Aquantuo. Compare it with this estimate.");
  } else if (provider === "aquantuo") {
    steps.push("Open Aquantuo's Buy For Me and paste the product link and the exact variant.",
      "Read what the quote covers: item, 7.5% fee, freight, customs and delivery.",
      "Pay Aquantuo on its site if you accept it. Bring the quote reference back here.");
  } else if (mode === "amazon_buy_ship") {
    steps.push("Open Kentex's Amazon quote tool and paste the exact product link and variant.",
      "If the quote includes the item, do not add the Amazon price again.",
      "Bring the quote reference and its expiry back here, then accept or pay on Kentex's site.");
  } else {
    steps.push("Check the forwarding rate on Kentex's page and enter the details above.", "Sign in to your Kentex account and read your warehouse address there.", WAREHOUSE,
      "Check the retailer accepts that address, then buy and pay the retailer yourself.",
      "When the retailer sends tracking, create the pre-alert on Kentex's site with it.",
      "Pay Kentex's freight invoice on its site when it arrives.");
  }
  return { officialUrl: mode === "self_buy" || mode === "forwarding" ? urls.estimator : urls.quote, fields, steps, missing };
}
