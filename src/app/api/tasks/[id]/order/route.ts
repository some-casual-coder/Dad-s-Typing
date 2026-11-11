import { createSellerOrder } from "@/domain/tasks";
import { bearer, handle, json, readJson, uuid } from "../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const b = await readJson(req, 1_000);
  return json(await createSellerOrder(uuid(id), token, { selectionId: uuid(b.selectionId) }));
});
