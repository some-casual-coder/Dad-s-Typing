import { readSigned } from "@/channel/bridge";
import { ackOutbox } from "@/channel/outbox";
import { handle, json, str, uuid } from "@/app/api/_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const b = await readSigned(req);
  const state = str(b, "state", { max: 10, min: 1 })!;
  const providerMessageId = str(b, "providerMessageId", { max: 128, optional: true });
  const error = str(b, "error", { max: 60, optional: true });
  return json(await ackOutbox(uuid(id), { state, providerMessageId, error }));
});
