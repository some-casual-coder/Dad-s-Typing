import { authorize, can } from "./access";
import { tx } from "./db";
import { orderView } from "./tasks";

export type NextAction =
  | "waiting_for_input" | "ready_for_choice" | "awaiting_payer" | "checking_payment" | "paid" | "cancelled" | "buy_at_retailer";

export async function getTaskView(taskId: string, token: string) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "view");
    const t = (await c.query(`SELECT * FROM tasks WHERE id=$1`, [taskId])).rows[0];
    const sel = (await c.query(`SELECT * FROM selections WHERE task_id=$1 AND superseded_at IS NULL`, [taskId])).rows[0];
    // a paid order is the truth even if the choice moved on afterwards
    const paid = (await c.query(`SELECT * FROM seller_orders WHERE task_id=$1 AND status='paid' LIMIT 1`, [taskId])).rows[0];
    const ord = paid ?? (sel ? (await c.query(`SELECT * FROM seller_orders WHERE selection_id=$1`, [sel.id])).rows[0] : undefined);
    const reqs = (await c.query(`SELECT id,key,op,value,unit,essential,status FROM requirements WHERE task_id=$1 AND superseded_at IS NULL ORDER BY created_at`, [taskId])).rows;
    const stale = !!sel && sel.task_version !== t.version && !ord;

    let next: NextAction;
    if (t.cancelled_at) next = "cancelled";
    else if (ord?.status === "paid") next = "paid";
    else if (ord?.status === "pending") next = "checking_payment";
    else if (ord) next = "awaiting_payer";
    else if (sel && !stale) next = sel.offer_snapshot.route === "paypal" ? "awaiting_payer" : "buy_at_retailer";
    else if ((await c.query(`SELECT 1 FROM offers WHERE task_id=$1 LIMIT 1`, [taskId])).rowCount) next = "ready_for_choice";
    else next = "waiting_for_input";

    const showOrder = ord && can(g.roles, "review_order");
    const viewer = { roles: g.roles };
    return {
      id: t.id, title: t.title, purpose: t.purpose, version: t.version as number, nextAction: next, viewer,
      requirements: reqs,
      selection: sel ? { id: sel.id, stale, title: sel.offer_snapshot.title, seller: sel.offer_snapshot.seller, route: sel.offer_snapshot.route, reason: sel.reason, chosenAt: sel.created_at } : null,
      // order detail is payer-only; the receipt is shared
      order: showOrder ? orderView(ord) : null,
      receipt: ord?.status === "paid"
        ? { seller: ord.seller, title: ord.title, sku: ord.sku, currency: ord.currency, totalMinor: ord.total_minor, taskId: t.id }
        : null,
    };
  });
}
