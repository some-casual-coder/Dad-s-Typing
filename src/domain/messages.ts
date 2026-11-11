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
    author: assistant ? "Assistant" : ((m.label as string) || (m.roles as string[] | null)?.[0] || "Someone"),
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
export async function recordAssistantMessage(taskId: string, body: string, exchange?: { clientMessageId: string; result: ExchangeResult }) {
  return tx(async (c) => {
    const id = randomUUID();
    await c.query(
      `INSERT INTO messages (id,task_id,grant_id,channel,provider_message_id,body) VALUES ($1,$2,NULL,'assistant',$3,$4)`,
      [id, taskId, randomUUID(), body],
    );
    if (exchange) {
      await c.query(
        `INSERT INTO idempotency (scope, key, command, request_hash, result) VALUES ($1,$2,'message','-',$3) ON CONFLICT DO NOTHING`,
        [`msg:${taskId}`, exchange.clientMessageId, JSON.stringify({ assistantId: id, ...exchange.result })],
      );
    }
    await logEvent(c, taskId, null, "message.replied", {});
    return { id };
  });
}

// The stored outcome of one browser message: user message, reply, proposals
export async function getExchange(taskId: string, token: string, clientMessageId: string) {
  return tx(async (c) => {
    await authorize(c, taskId, token, "message");
    const user = (await c.query(`${SELECT} WHERE m.task_id=$1 AND m.channel='browser' AND m.provider_message_id=$2`, [taskId, `${taskId}:${clientMessageId}`])).rows[0];
    const stored = (await c.query(`SELECT result FROM idempotency WHERE scope=$1 AND key=$2`, [`msg:${taskId}`, clientMessageId])).rows[0]?.result as
      | (ExchangeResult & { assistantId: string }) | undefined;
    const reply = stored ? (await c.query(`${SELECT} WHERE m.id=$1 AND m.task_id=$2`, [stored.assistantId, taskId])).rows[0] : undefined;
    return {
      messages: [user, reply].filter(Boolean).map(view),
      proposals: stored?.proposals ?? [],
      clarification: stored?.clarification ?? null,
    };
  });
}
