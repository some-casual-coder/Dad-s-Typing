import type { Role } from "@/domain/access";
import { createInvite } from "@/domain/tasks";
import { bearer, handle, invalid, json, readJson, str, uuid } from "../../../_lib/http";

const ROLES = ["requester", "helper", "chooser", "payer"];

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const taskId = uuid(id);
  const b = await readJson(req, 5_000);
  const r = b.roles;
  if (!Array.isArray(r) || !r.length || r.length > 4 || r.some((x) => typeof x !== "string" || !ROLES.includes(x))) throw invalid("Bad roles");
  const label = str(b, "label", { max: 80, optional: true });
  const ttl = b.ttlMinutes;
  if (ttl !== undefined && (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > 60 * 24 * 30)) throw invalid("ttlMinutes is invalid");
  const g = await createInvite(taskId, token, { roles: r as Role[], label, ttlMinutes: ttl as number | undefined });
  const base = process.env.APP_BASE_URL ?? "";
  return json({ grantId: g.grantId, token: g.token, link: `${base}/t/${taskId}#k=${g.token}` }, 201);
});
