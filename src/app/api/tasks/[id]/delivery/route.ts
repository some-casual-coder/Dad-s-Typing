import { getDelivery, saveDelivery, type DeliveryInput } from "@/domain/delivery";
import { bearer, clientIp, handle, json, rateLimit, readJson, uuid } from "../../../_lib/http";

export const GET = handle<{ id: string }>(async (req, { id }) => json(await getDelivery(uuid(id), bearer(req))));

export const PUT = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`dlv:${clientIp(req)}`, 60);
  const b = await readJson(req, 4_000);
  return json(await saveDelivery(uuid(id), bearer(req), b as unknown as DeliveryInput));
});
