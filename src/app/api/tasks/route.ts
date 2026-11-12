import { seedDemoOffers, seedExternalOffers } from "@/catalog/demo";
import type { Role } from "@/domain/access";
import { claimExternalSearch } from "@/domain/offers";
import { createTask } from "@/domain/tasks";
import { clientIp, handle, invalid, json, rateLimit, readJson, str } from "../_lib/http";

const ROLES = ["requester", "helper", "chooser", "payer"];

export const POST = handle(async (req) => {
  rateLimit(`task:${clientIp(req)}`, 20);
  const b = await readJson(req, 10_000);
  const title = str(b, "title", { max: 200, min: 1 })!;
  const purpose = str(b, "purpose", { max: 2000, optional: true });
  const label = str(b, "label", { max: 80, optional: true });
  let starterRoles: Role[] | undefined;
  if (b.starterRoles !== undefined) {
    const r = b.starterRoles;
    if (!Array.isArray(r) || !r.length || r.length > 4 || r.some((x) => typeof x !== "string" || !ROLES.includes(x))) throw invalid("Bad roles");
    starterRoles = r as Role[];
  }
  const { taskId, token } = await createTask({ title, purpose, starterRoles, starterLabel: label });
  // Seeding is best effort; the task is usable without offers
  await seedDemoOffers(taskId, `${title} ${purpose ?? ""}`).catch(() => console.error("api_error", "seed_demo"));
  // a photo start has no useful title: the AI names the item and seeds these later
  if (b.seedExternal !== false && (await claimExternalSearch(taskId, title))) await seedExternalOffers(taskId, title).catch(() => console.error("api_error", "seed_external"));
  return json({ taskId, token }, 201);
});
