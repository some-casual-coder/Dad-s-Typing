import { getComparison } from "@/domain/tasks";
import { bearer, handle, json, uuid } from "../../../_lib/http";

export const GET = handle<{ id: string }>(async (req, { id }) =>
  json(await getComparison(uuid(id), bearer(req))));
