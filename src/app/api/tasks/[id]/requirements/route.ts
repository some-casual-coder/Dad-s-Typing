import type { Op } from "@/domain/eligibility";
import { setRequirement } from "@/domain/tasks";
import { bearer, handle, idempotencyKey, invalid, json, readJson, str, uuid } from "../../../_lib/http";

const OPS = ["eq", "neq", "lte", "gte"];

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const b = await readJson(req, 5_000);
  const key = str(b, "key", { max: 60, min: 1 })!;
  const op = str(b, "op", { max: 12, optional: true });
  if (op !== undefined && !OPS.includes(op)) throw invalid("op is invalid");
  const unit = str(b, "unit", { max: 20, optional: true });
  const value = b.value;
  if (typeof value === "string") { if (!value.length || value.length > 200) throw invalid("value is invalid"); }
  else if (typeof value !== "number" || !Number.isFinite(value)) throw invalid("value is invalid");
  if (b.essential !== undefined && typeof b.essential !== "boolean") throw invalid("essential is invalid");
  const result = await setRequirement(
    uuid(id), token,
    { key, op: op as Op | undefined, value: value as string | number, unit, essential: b.essential as boolean | undefined },
    { idempotencyKey: idempotencyKey(req) },
  );
  return json(result);
});
