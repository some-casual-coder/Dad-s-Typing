import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "./errors";
import { tx, type Tx } from "./db";

export type Role = "requester" | "helper" | "chooser" | "payer";
export type Action =
  | "view" | "message" | "propose_requirement" | "confirm_requirement"
  | "choose" | "invite" | "revoke" | "review_order" | "pay";

export const ROLE_ACTIONS: Record<Role, Action[]> = {
  requester: ["view", "message", "propose_requirement", "confirm_requirement", "choose", "invite", "revoke"],
  helper: ["view", "message", "propose_requirement", "invite"],
  chooser: ["view", "message", "choose"],
  payer: ["view", "review_order", "pay"],
};

export interface Grant { id: string; taskId: string; roles: Role[]; canDelegate: boolean }

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = () => randomBytes(24).toString("base64url");

// Creator or requester: any role. Others: only roles they already hold
export function canMint(g: Pick<Grant, "roles" | "canDelegate">, role: Role): boolean {
  return g.canDelegate || g.roles.includes(role) || g.roles.includes("requester");
}

export function can(roles: Role[], action: Action): boolean {
  return roles.some((r) => ROLE_ACTIONS[r]?.includes(action));
}

// Every failed lookup reads as not found so tasks can't be probed
export async function authorize(c: Tx, taskId: string, token: string, action: Action): Promise<Grant> {
  const { rows } = await c.query(
    `SELECT id, task_id, roles, can_delegate FROM grants
      WHERE task_id = $1 AND token_hash = $2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [taskId, hashToken(token ?? "")],
  );
  if (!rows[0]) throw new DomainError("not_found", "Task not found");
  const grant: Grant = { id: rows[0].id, taskId: rows[0].task_id, roles: rows[0].roles, canDelegate: rows[0].can_delegate };
  if (!can(grant.roles, action)) throw new DomainError("forbidden", `Your role cannot ${action.replace("_", " ")}`);
  return grant;
}

export const resolveGrant = (taskId: string, token: string, action: Action) =>
  tx((c) => authorize(c, taskId, token, action));
