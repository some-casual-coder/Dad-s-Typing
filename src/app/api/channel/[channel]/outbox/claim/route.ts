import { readSigned } from "@/channel/bridge";
import { claimOutbox } from "@/channel/outbox";
import { handle, json } from "@/app/api/_lib/http";

export const POST = handle<{ channel: string }>(async (req, { channel }) => {
  const b = await readSigned(channel, req);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return json({ items: await claimOutbox(channel, num(b.limit), num(b.leaseSeconds)) });
});
