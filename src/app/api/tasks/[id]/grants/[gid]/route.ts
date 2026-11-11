import { revokeGrant } from "@/domain/tasks";
import { bearer, handle, uuid } from "../../../../_lib/http";

export const DELETE = handle<{ id: string; gid: string }>(async (req, { id, gid }) => {
  await revokeGrant(uuid(id), bearer(req), uuid(gid));
  return new Response(null, { status: 204 });
});
