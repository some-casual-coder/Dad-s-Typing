import { randomUUID } from "node:crypto";
import { authorize } from "./access";
import { tx } from "./db";
import { logEvent } from "./events";

type Row = Record<string, unknown>;

const view = (m: Row) => {
  const assistant = m.channel === "assistant";
  return {
    id: m.id as string,
    role: assistant ? ("assistant" as const) : ("user" as const),
    // People see a name, never an internal role
    author: assistant ? "Assistant" : (m.label as string) || "Shopper",
    body: m.body as string,
    hasImage: m.media_ref != null,
    createdAt: m.created_at as string,
  };
};

const SELECT = `SELECT m.id, m.channel, m.body, m.media_ref, m.created_at, g.label, g.roles
  FROM messages m LEFT JOIN grants g ON g.id = m.grant_id`;

export async function listMessages(taskId: string, token: string) {
  return tx(async (c) => {
    await authorize(c, taskId, token, "view");
    const { rows } = await c.query(`${SELECT} WHERE m.task_id = $1 ORDER BY m.created_at, m.id`, [taskId]);
    return rows.map(view);
  });
}

export interface ExchangeResult { proposals: unknown[]; clarification: string | null }

// Server-only: callers must already have authorized the exchange
export async function recordAssistantMessage(taskId: string, body: string, exchange?: { key: string; result: ExchangeResult }) {
  return tx(async (c) => {
    const id = randomUUID();
    await c.query(
      `INSERT INTO messages (id,task_id,grant_id,channel,provider_message_id,body) VALUES ($1,$2,NULL,'assistant',$3,$4)`,
      [id, taskId, randomUUID(), body],
    );
    if (exchange) {
      await c.query(
        `INSERT INTO idempotency (scope, key, command, request_hash, result) VALUES ($1,$2,'message','-',$3) ON CONFLICT DO NOTHING`,
        [`msg:${taskId}`, exchange.key, JSON.stringify({ assistantId: id, ...exchange.result })],
      );
    }
    await logEvent(c, taskId, null, "message.replied", {});
    return { id };
  });
}

// The stored outcome of one browser message: user message, reply, proposals
export async function getExchange(taskId: string, token: string, exchangeKey: string, channel = "browser") {
  return tx(async (c) => {
    await authorize(c, taskId, token, "message");
    const user = (await c.query(`${SELECT} WHERE m.task_id=$1 AND m.channel=$3 AND m.provider_message_id=$2`, [taskId, exchangeKey, channel])).rows[0];
    const stored = (await c.query(`SELECT result FROM idempotency WHERE scope=$1 AND key=$2`, [`msg:${taskId}`, exchangeKey])).rows[0]?.result as
      | (ExchangeResult & { assistantId: string }) | undefined;
    const reply = stored ? (await c.query(`${SELECT} WHERE m.id=$1 AND m.task_id=$2`, [stored.assistantId, taskId])).rows[0] : undefined;
    return {
      messages: [user, reply].filter(Boolean).map(view),
      proposals: stored?.proposals ?? [],
      clarification: stored?.clarification ?? null,
    };
  });
}

// Proposals from this grant's latest exchange that are not yet confirmed. A chat
// channel keys its exchanges by message id, so those are found through the
// messages this grant sent; the page then shows what the chat asked to confirm.
export async function pendingProposals(taskId: string, token: string) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "message");
    const last = (await c.query(
      `SELECT result FROM idempotency WHERE scope=$1 AND result IS NOT NULL
          AND (key LIKE $2 OR key IN (SELECT provider_message_id FROM messages WHERE task_id=$3 AND grant_id=$4))
        ORDER BY created_at DESC LIMIT 1`,
      [`msg:${taskId}`, `${g.id}:%`, taskId, g.id],
    )).rows[0]?.result as { proposals?: { key: string; op: string; value: string | number }[] } | undefined;
    const confirmed = (await c.query(`SELECT key, op, value FROM requirements WHERE task_id=$1 AND status='confirmed' AND superseded_at IS NULL`, [taskId])).rows;
    return (last?.proposals ?? []).filter((p) => !confirmed.some((r) => r.key === p.key && r.op === p.op && String(r.value) === String(p.value)));
  });
}
