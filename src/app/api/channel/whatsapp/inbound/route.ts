import { readSigned } from "@/channel/bridge";
import { enqueueInbound, parseInbound } from "@/channel/inbox";
import { handle, json } from "@/app/api/_lib/http";

export const POST = handle(async (req) => {
  const status = await enqueueInbound(parseInbound(await readSigned(req)));
  return json({ status }, 202);
});
