import { createJoinCode } from "@/channel/join";
import { bearer, clientIp, handle, json, rateLimit, uuid } from "../../../_lib/http";

// A one-time code to get order updates on WhatsApp
export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`join:${clientIp(req)}`, 10);
  return json(await createJoinCode(uuid(id), bearer(req)));
});
