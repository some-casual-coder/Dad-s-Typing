import { decideExtra } from "@/domain/concierge";
import { DomainError } from "@/domain/errors";
import { bearer, clientIp, handle, json, rateLimit, readJson, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`oextra:${clientIp(req)}`, 10);
  const d = (await readJson(req, 200)).decision;
  if (d !== "approved" && d !== "declined") throw new DomainError("invalid", "decision is invalid");
  return json(await decideExtra(uuid(id), bearer(req), d));
});
