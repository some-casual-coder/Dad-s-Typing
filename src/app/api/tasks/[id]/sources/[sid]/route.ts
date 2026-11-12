import { DomainError } from "@/domain/errors";
import { rejectCandidates, retrySource } from "@/sources/intake";
import { bearer, clientIp, handle, json, rateLimit, readJson, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string; sid: string }>(async (req, { id, sid }) => {
  rateLimit(`src:${clientIp(req)}`, 20);
  const action = (await readJson(req, 200)).action;
  if (action === "retry") return json(await retrySource(uuid(id), bearer(req), uuid(sid)));
  if (action === "something_else") return json(await rejectCandidates(uuid(id), bearer(req), uuid(sid)));
  throw new DomainError("invalid", "action is invalid");
});
