import { chooseRoute } from "@/domain/tasks";
import { bearer, clientIp, handle, json, rateLimit, readJson, str, uuid } from "../../../../_lib/http";

// The payer picks how an import reaches Kenya; returns the repriced checkout
export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`route:${clientIp(req)}`, 30);
  const token = bearer(req);
  const b = await readJson(req, 2_000);
  return json(await chooseRoute(uuid(id), token, str(b, "planId", { max: 200 })!));
});
