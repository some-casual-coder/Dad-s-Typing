import { readSigned } from "@/channel/bridge";
import { claimOutbox } from "@/channel/outbox";
import { handle, json } from "@/app/api/_lib/http";

export const POST = handle(async (req) => {
  const b = await readSigned(req);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return json({ items: await claimOutbox(num(b.limit), num(b.leaseSeconds)) });
});
