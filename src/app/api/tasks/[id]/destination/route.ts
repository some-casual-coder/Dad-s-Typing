import { setDestination } from "@/domain/destination";
import { bearer, clientIp, handle, json, rateLimit, readJson, uuid } from "../../../_lib/http";

export const PUT = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`dst:${clientIp(req)}`, 30);
  const b = (await readJson(req, 1_000)) as { confirm?: boolean; place?: string; handling?: "pickup" | "door" };
  return json(await setDestination(uuid(id), bearer(req), { confirm: b.confirm, place: b.place, handling: b.handling }));
});
