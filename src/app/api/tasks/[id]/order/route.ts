import { createSellerOrder, previewOrder } from "@/domain/tasks";
import { bearer, handle, json, readJson, uuid } from "../../../_lib/http";

// Read-only: what Pay would charge now. Opening or refreshing creates nothing.
export const GET = handle<{ id: string }>(async (req, { id }) => json(await previewOrder(uuid(id), bearer(req))));

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const b = await readJson(req, 1_000);
  const expected = typeof b.expectedTotalMinor === "number" && Number.isSafeInteger(b.expectedTotalMinor) ? b.expectedTotalMinor : undefined;
  return json(await createSellerOrder(uuid(id), token, { selectionId: uuid(b.selectionId), expectedTotalMinor: expected }));
});
