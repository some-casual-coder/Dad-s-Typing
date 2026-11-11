import { readSigned } from "@/channel/bridge";
import { ackOutbox } from "@/channel/outbox";
import { handle, json, str, uuid } from "@/app/api/_lib/http";

export const POST = handle<{ channel: string; id: string }>(async (req, { channel, id }) => {
  const b = await readSigned(channel, req);
  const state = str(b, "state", { max: 10, min: 1 })!;
  const providerMessageId = str(b, "providerMessageId", { max: 128, optional: true });
  const error = str(b, "error", { max: 60, optional: true });
  return json(await ackOutbox(channel, uuid(id), { state, providerMessageId, error }));
});
