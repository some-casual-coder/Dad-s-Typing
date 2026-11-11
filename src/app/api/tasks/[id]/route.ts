import { getTaskView } from "@/domain/view";
import { bearer, handle, json, uuid } from "../../_lib/http";

export const GET = handle<{ id: string }>(async (req, { id }) =>
  json(await getTaskView(uuid(id), bearer(req))));
