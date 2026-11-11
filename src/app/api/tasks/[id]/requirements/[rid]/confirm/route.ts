import { confirmRequirement } from "@/domain/tasks";
import { bearer, handle, json, uuid } from "../../../../../_lib/http";

export const POST = handle<{ id: string; rid: string }>(async (req, { id, rid }) =>
  json(await confirmRequirement(uuid(id), bearer(req), uuid(rid))));
