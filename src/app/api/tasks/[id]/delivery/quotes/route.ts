import { importQuote } from "@/domain/delivery";
import { bearer, clientIp, handle, json, rateLimit, readJson, str, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`dlvq:${clientIp(req)}`, 30);
  const b = await readJson(req, 4_000);
  return json(await importQuote(uuid(id), bearer(req), {
    offerId: uuid(b.offerId), provider: str(b, "provider", { max: 20 })!, mode: str(b, "mode", { max: 30 })!,
    reference: str(b, "reference", { max: 80, min: 1 })!, amountMinor: b.amountMinor as number, currency: str(b, "currency", { max: 3, min: 3 })!,
    includesItem: b.includesItem === true, includesCustoms: b.includesCustoms === true, includesDelivery: b.includesDelivery === true,
    expiresAt: str(b, "expiresAt", { max: 40, optional: true }) ?? null,
  }));
});
