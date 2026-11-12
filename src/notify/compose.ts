import { formatRange, type Eta } from "@/delivery/eta";
import { mapsLink, mapsSearch, type Hub } from "@/delivery/hubs";

// Assistant-style notices: what happened, what is next, when. Facts come from
// the order; nothing here is model-written. Channel-neutral: each channel
// renders the place and contact as it can (pin, card, link, text).
export type NoticeStatus = "paid" | "ordered" | "at_warehouse" | "departed" | "cleared" | "ready_to_collect" | "out_for_delivery" | "delivered"
  | "cancelled" | "stock_out" | "needs_approval" | "settled";

export interface Place { name: string; address: string | null; pin: { lat: number; lon: number; approximate: boolean } | null; mapsUrl: string | null; hours: string | null }
export interface Contact { name: string; phone: string }
export interface Notice { audience: "all" | "payer"; body: string; place?: Place; contact?: Contact }

export interface NoticeCtx {
  item: string; provider: string; eta: Eta | null; currency: string; capMinor: number; actualMinor: number | null; extraMinor: number | null; link: string;
}

const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toFixed(2)}`;
const who = (p: string) => (p === "kentex" ? "Kentex" : p === "aquantuo" ? "Aquantuo" : "the forwarder");

export function placeOf(hub: Hub): Place {
  const pin = hub.pin ? { lat: hub.pin.lat, lon: hub.pin.lon, approximate: hub.pin.approximate } : null;
  return { name: hub.name, address: hub.address, pin, hours: hub.hours,
    mapsUrl: pin ? mapsLink(pin) : hub.address ? mapsSearch(hub.address) : null };
}

export function compose(status: NoticeStatus, x: NoticeCtx, hub: Hub | null): Notice[] {
  const arrive = x.eta ? formatRange(x.eta.earliest, x.eta.latest) : null;
  const all = (body: string): Notice[] => [{ audience: "all", body }];
  switch (status) {
    case "paid": return all(`Payment received for the ${x.item}. I'm placing the order now${arrive ? `; it should reach you ${arrive}` : ""}.`);
    case "ordered": return all(`I've ordered the ${x.item} from the store. Next stop: ${who(x.provider)}'s US warehouse.`);
    case "at_warehouse": return all(`The ${x.item} has arrived at ${who(x.provider)}'s US warehouse. It flies to Nairobi next${arrive ? `, arriving ${arrive}` : ""}.`);
    case "departed": return all(`The ${x.item} is on the plane to Nairobi${arrive ? `. Expected ${arrive}` : ""}.`);
    case "cleared": return all(`The ${x.item} has cleared customs in Nairobi. I'll tell you as soon as it's ready.`);
    case "out_for_delivery": return all(`The ${x.item} is out for delivery today.`);
    case "delivered": return all(`Delivered. I hope the ${x.item} is just right. Reply here if anything is wrong.`);
    case "stock_out": return all(`Sorry, the store ran out of the ${x.item}. The payment is being refunded in full. Reply and I'll find a similar one.`);
    case "cancelled": return [{ audience: "payer", body: `Cancelled. The full ${money(x.capMinor, x.currency)} is being refunded to your PayPal.` },
      { audience: "all", body: "Cancelled, and the payment is being refunded in full." }];
    case "needs_approval": return x.extraMinor
      ? [{ audience: "payer", body: `The final shipping bill for the ${x.item} is ${money(x.extraMinor, x.currency)} above what you paid. Please approve or decline here: ${x.link}` }] : [];
    case "settled":
      if (x.actualMinor !== null && x.actualMinor < x.capMinor)
        return [{ audience: "payer", body: `Final cost settled at ${money(x.actualMinor, x.currency)}. ${money(x.capMinor - x.actualMinor, x.currency)} is on its way back to your PayPal.` }];
      if (x.actualMinor !== null && x.actualMinor > x.capMinor)
        return [{ audience: "payer", body: `Thanks, the extra ${money(x.actualMinor - x.capMinor, x.currency)} is paid. The ${x.item} is fully settled.` }];
      return [];
    case "ready_to_collect": return [ready(x, hub)];
  }
}

function ready(x: NoticeCtx, hub: Hub | null): Notice {
  if (!hub) return { audience: "all", body: `Good news: the ${x.item} is ready to collect in Nairobi. ${who(x.provider)} will confirm where to collect it; wait for their instructions before travelling.` };
  const lines = [`Good news: the ${x.item} is ready to collect at ${hub.name}${hub.address ? `, ${hub.address}` : ""}.`];
  if (hub.hours) lines.push(`Open ${hub.hours}.`);
  lines.push(hub.bring);
  return { audience: "all", body: lines.join(" "), place: placeOf(hub), ...(hub.phone ? { contact: { name: hub.name, phone: hub.phone } } : {}) };
}

export function reminder(x: NoticeCtx, hub: Hub): Notice {
  return { audience: "all", body: `Reminder: the ${x.item} is waiting for you at ${hub.name}${hub.address ? `, ${hub.address}` : ""}. ${hub.bring}`, place: placeOf(hub) };
}

// Text-only rendering for channels without pins or cards (SMS, email...)
export function asText(n: Notice): string {
  const extra: string[] = [];
  if (n.place?.mapsUrl) extra.push(`Map${n.place.pin?.approximate ? " (approximate)" : ""}: ${n.place.mapsUrl}`);
  if (n.contact) extra.push(`Call ${n.contact.phone}.`);
  return [n.body, ...extra].join(" ");
}
