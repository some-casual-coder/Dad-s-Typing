import { selectOffer } from "@/domain/tasks";
import { bearer, handle, idempotencyKey, invalid, json, readJson, str, uuid } from "../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const b = await readJson(req, 5_000);
  const offerId = uuid(b.offerId);
  if (!Number.isInteger(b.expectedVersion)) throw invalid("expectedVersion is invalid");
  const reason = str(b, "reason", { max: 500, optional: true });
  return json(await selectOffer(uuid(id), token, { offerId, expectedVersion: b.expectedVersion as number, reason }, { idempotencyKey: idempotencyKey(req) }));
});
