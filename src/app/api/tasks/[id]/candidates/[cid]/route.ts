import { chooseCandidate } from "@/sources/intake";
import { bearer, clientIp, handle, json, rateLimit, uuid } from "../../../../_lib/http";

// "Find this item": the shopper's pick, then the existing search
export const POST = handle<{ id: string; cid: string }>(async (req, { id, cid }) => {
  rateLimit(`cand:${clientIp(req)}`, 20);
  return json(await chooseCandidate(uuid(id), bearer(req), uuid(cid)));
});
