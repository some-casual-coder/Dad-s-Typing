export type Op = "eq" | "neq" | "lte" | "gte";
export interface Requirement { key: string; op: Op; value: string | number; unit?: string | null; essential: boolean }
export interface Attribute { value: string | number; unit?: string; source?: string }
export type CheckResult = "match" | "mismatch" | "unknown";
export interface Check { key: string; essential: boolean; result: CheckResult; reason: string }
export interface Eligibility { status: "eligible" | "ineligible" | "unresolved"; checks: Check[] }

const LENGTH_CM: Record<string, number> = { mm: 0.1, cm: 1, m: 100, in: 2.54 };

function numeric(v: string | number, unit?: string | null): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (!unit) return n;
  const f = LENGTH_CM[unit];
  return f === undefined ? null : n * f;
}

function compare(req: Requirement, attr: Attribute | undefined): { result: CheckResult; reason: string } {
  if (!attr) return { result: "unknown", reason: `No evidence for ${req.key}` };
  if (req.op === "eq" || req.op === "neq") {
    const same = String(attr.value).toLowerCase() === String(req.value).toLowerCase();
    const ok = req.op === "eq" ? same : !same;
    return { result: ok ? "match" : "mismatch", reason: `${req.key} is ${attr.value}${attr.source ? ` (${attr.source})` : ""}` };
  }
  const a = numeric(attr.value, attr.unit);
  const r = numeric(req.value, req.unit);
  if (a === null || r === null) return { result: "unknown", reason: `${req.key} cannot be compared (units)` };
  const ok = req.op === "lte" ? a <= r : a >= r;
  return { result: ok ? "match" : "mismatch", reason: `${req.key} is ${attr.value}${attr.unit ?? ""}` };
}

export function evaluate(reqs: Requirement[], attrs: Record<string, Attribute>): Eligibility {
  const checks = reqs.map((r) => ({ key: r.key, essential: r.essential, ...compare(r, attrs[r.key]) }));
  const essential = checks.filter((c) => c.essential);
  const status = essential.some((c) => c.result === "mismatch")
    ? "ineligible"
    : essential.some((c) => c.result === "unknown")
      ? "unresolved"
      : "eligible";
  return { status, checks };
}
