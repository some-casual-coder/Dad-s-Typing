import { isKenyanNumber, placeFromText, type Place } from "@/delivery/places";
import { authorize } from "./access";
import { tx, type Tx } from "./db";
import { DomainError } from "./errors";
import { logEvent } from "./events";

export type DestSource = "answer" | "profile" | "location" | "country_code" | "default";
export interface Destination { county: string; area: string; handling: "pickup" | "door"; source: DestSource; confirmed: boolean }

// Nairobi is the default guess; the person confirms it in one reply
export const DEFAULT_PLACE: Place = { county: "Nairobi", area: "" };

export async function getDestination(c: Tx, taskId: string): Promise<Destination | null> {
  const r = (await c.query(`SELECT county, city, handling, source, confirmed FROM delivery_plans WHERE task_id=$1`, [taskId])).rows[0];
  if (!r || !r.county) return null;
  return { county: r.county, area: r.city, handling: r.handling, source: r.source, confirmed: r.confirmed };
}

export async function putDestination(c: Tx, taskId: string, p: Place, source: DestSource, confirmed: boolean, handling?: "pickup" | "door") {
  await c.query(
    `INSERT INTO delivery_plans (task_id,county,city,handling,source,confirmed,updated_at) VALUES ($1,$2,$3,COALESCE($6,'pickup'),$4,$5,now())
     ON CONFLICT (task_id) DO UPDATE SET county=$2, city=$3, source=$4, confirmed=$5, handling=COALESCE($6, delivery_plans.handling), updated_at=now()`,
    [taskId, p.county.slice(0, 80), p.area.slice(0, 80), source, confirmed, handling ?? null],
  );
}

export async function saveProfile(c: Tx, channel: string, senderHash: string, d: { county: string; area: string; handling: "pickup" | "door" }) {
  await c.query(
    `INSERT INTO sender_profiles (channel,sender_hash,county,area,handling,updated_at) VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (channel,sender_hash) DO UPDATE SET county=$3, area=$4, handling=$5, updated_at=now()`,
    [channel, senderHash, d.county.slice(0, 80), d.area.slice(0, 80), d.handling],
  );
}

// For a new task from a chat sender: saved profile, else a +254 default to confirm
export async function inferForSender(c: Tx, taskId: string, channel: string, senderHash: string, sender: string): Promise<"known" | "ask" | "none"> {
  const p = (await c.query(`SELECT county, area, handling FROM sender_profiles WHERE channel=$1 AND sender_hash=$2`, [channel, senderHash])).rows[0];
  if (p) {
    await putDestination(c, taskId, { county: p.county, area: p.area }, "profile", true, p.handling);
    return "known";
  }
  if (isKenyanNumber(sender)) {
    await putDestination(c, taskId, DEFAULT_PLACE, "country_code", false);
    return "ask";
  }
  return "none";
}

export const placeLabel = (d: { county: string; area: string }) =>
  !d.area || d.area === d.county ? d.county : d.area.includes(d.county) ? d.area : `${d.area}, ${d.county}`;

// Pickup in Nairobi is the default; a place only matters for door delivery
export const askLine = () =>
  "You collect it in Nairobi at no extra cost. Reply YES, or name your town or share a location pin to have it delivered.";

const YES = /^\s*(yes|yeah|yep|y|ok|okay|sure|ndio|ndiyo|sawa|collect|pickup|pick up)\b[\s.!]*$/i;
const DOOR = /\b(door|deliver|delivery|bring it|home)\b/i;

export type Answer = Place & { handling: "pickup" | "door" };

// A short chat reply that answers the question, or null. Naming a place
// means delivery there; YES keeps pickup.
export function answerFromText(text: string, current: Destination | null): Answer | null {
  if (current && YES.test(text)) return { county: current.county, area: current.area, handling: "pickup" };
  if (text.length > 60) return null;
  const p = placeFromText(text);
  if (p) return { ...p, handling: "door" };
  if (current && DOOR.test(text)) return { county: current.county, area: current.area, handling: "door" };
  return null;
}

// Browser fallback: "yes" to the default or a typed place
export async function setDestination(taskId: string, token: string, b: { confirm?: boolean; place?: string; handling?: "pickup" | "door" }) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "message");
    if (b.handling !== undefined && b.handling !== "pickup" && b.handling !== "door") throw new DomainError("invalid", "handling is invalid");
    const cur = await getDestination(c, taskId);
    let p: Place | null = null;
    if (b.confirm === true) p = cur ? { county: cur.county, area: cur.area } : DEFAULT_PLACE;
    else if (b.handling === "door" && !b.place && (!cur || cur.source === "country_code")) throw new DomainError("invalid", "Name the town or area to deliver to");
    else if (typeof b.place === "string" && b.place.trim() && b.place.length <= 80) {
      // An unknown town is kept as typed, but never a street address
      const typed = b.place.trim().replace(/\s+/g, " ");
      p = placeFromText(typed) ?? (/^[\p{L}' .-]{2,40}$/u.test(typed) ? { county: typed, area: "" } : null);
      if (!p) throw new DomainError("invalid", "Name the town or area only, not a street address");
    } else if (b.handling && cur) p = { county: cur.county, area: cur.area };
    if (!p) throw new DomainError("invalid", "Say yes or name a place");
    await putDestination(c, taskId, p, "answer", true, b.handling);
    await logEvent(c, taskId, g.id, "delivery.destination", {});
    return { county: p.county, area: p.area };
  });
}
