import { readSigned } from "@/channel/bridge";
import { enqueueInbound, parseInbound } from "@/channel/inbox";
import { getChannel } from "@/channel/registry";
import { handle, json } from "@/app/api/_lib/http";

export const POST = handle<{ channel: string }>(async (req, { channel }) => {
  const def = getChannel(channel);
  const status = await enqueueInbound(channel, parseInbound(def, await readSigned(channel, req)));
  return json({ status }, 202);
});
