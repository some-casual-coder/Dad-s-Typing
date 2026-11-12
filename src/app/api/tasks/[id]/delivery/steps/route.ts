import { markStep } from "@/domain/delivery";
import { bearer, clientIp, handle, json, rateLimit, readJson, str, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`dlvs:${clientIp(req)}`, 60);
  const b = await readJson(req, 2_000);
  return json(await markStep(uuid(id), bearer(req), {
    offerId: uuid(b.offerId), provider: str(b, "provider", { max: 20 })!, mode: str(b, "mode", { max: 30 })!,
    step: str(b, "step", { max: 40 })!, note: str(b, "note", { max: 200, optional: true }),
  }));
});
