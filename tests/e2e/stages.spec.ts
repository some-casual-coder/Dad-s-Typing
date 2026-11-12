import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/x");
url.pathname = `/${process.env.TEST_DB_NAME ?? "dads_typing_test"}`;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
test.use(PHONE);

async function sql<T = Record<string, unknown>>(q: string, args: unknown[] = []): Promise<T[]> {
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try { return (await db.query(q, args)).rows as T[]; } finally { await db.end(); }
}

// A task in Choose: the item is named and one import offer exists
async function choosing(page: Page, roles: string[] = ["requester", "chooser", "helper", "payer"]) {
  const made = await (await page.request.post("/api/tasks", { data: { title: "Cat carrier", starterRoles: roles, seedExternal: false } })).json();
  await sql(`INSERT INTO offers (id,task_id,source,source_offer_id,route,seller,title,unit_price_minor,currency,availability,url,specs)
    VALUES ($1,$2,'channel3','E2E-ST','external','amazon.com','Fixture cat carrier',3000,'USD','InStock','https://www.amazon.com/dp/B012345678',$3)`,
    [randomUUID(), made.taskId, JSON.stringify({ weightGrams: 1200, lengthMm: 450, widthMm: 300, heightMm: 280 })]);
  await sql(`UPDATE tasks SET search_query='cat carrier' WHERE id=$1`, [made.taskId]);
  return made as { taskId: string; token: string };
}

async function open(page: Page, taskId: string, token: string) {
  await page.goto("/");
  await page.evaluate(([id, t]) => sessionStorage.setItem(`dt:token:${id}`, t), [taskId, token]);
  await page.goto(`/t/${taskId}`);
}

const filledNames = (page: Page) => page.evaluate(() => [...new Set([...document.querySelectorAll("button.btn:not(.secondary), a.btn:not(.secondary), label.btn:not(.secondary)")]
  .filter((b) => (b as HTMLElement).checkVisibility()).map((b) => (b.textContent ?? "").trim()))]);

async function invite(page: Page, taskId: string, token: string, roles: string[]) {
  const r = await page.request.post(`/api/tasks/${taskId}/invites`, { data: { roles, label: roles.join("+") }, headers: { authorization: `Bearer ${token}` } });
  return (await r.json()).token as string;
}

async function asOther(browser: Browser, taskId: string, token: string) {
  const ctx = await browser.newContext(PHONE);
  const p = await ctx.newPage();
  await open(p, taskId, token);
  return { p, ctx };
}

test("solo shopper: Choose above the fold, then Pay with one button and nothing created until Pay", async ({ page }) => {
  const t = await choosing(page);
  await open(page, t.taskId, t.token);
  const choose = page.locator("li.dcard").first().getByRole("button", { name: "Choose this one" });
  await expect(choose).toBeVisible();
  const box = (await choose.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(844 * 1.6);
  expect(await filledNames(page)).toEqual(["Choose this one"]);
  await expect(page.locator("body")).not.toContainText(/requester|chooser|You can:/i);
  await choose.click();

  const pay = page.getByRole("region", { name: /^Pay/ });
  const button = pay.getByRole("button", { name: "Pay with PayPal (sandbox)" });
  await expect(button).toBeVisible();
  expect(((await button.boundingBox())!.y)).toBeLessThan(844 * 2);
  await expect(page.getByRole("button", { name: "Choose this one" })).toHaveCount(0);
  expect(await filledNames(page)).toEqual(["Pay with PayPal (sandbox)"]);
  await expect(page.getByText("Get updates on WhatsApp")).toHaveCount(0);

  // Opening and refreshing Pay creates no order and no PayPal attempt
  await page.reload();
  await expect(button).toBeVisible();
  const counts = async () => (await sql<{ o: number; a: number }>(`SELECT (SELECT count(*)::int FROM seller_orders WHERE task_id=$1) o,
    (SELECT count(*)::int FROM payment_attempts a JOIN seller_orders s ON s.id=a.seller_order_id WHERE s.task_id=$1) a`, [t.taskId]))[0];
  expect(await counts()).toEqual({ o: 0, a: 0 });

  // A double tap makes one order and one PayPal attempt (sandbox; navigation stopped here)
  await page.route("**/*.paypal.com/**", (r) => r.abort());
  await button.dblclick();
  await expect.poll(counts, { timeout: 30_000 }).toEqual({ o: 1, a: 1 });
});

test("Mum chooses without seeing money or 'Send to Mum'; a payer-only link opens on Pay", async ({ page, browser }) => {
  const t = await choosing(page, ["helper", "payer"]);
  await open(page, t.taskId, t.token);
  // The person shopping for Mum leads with sending her the link
  await expect(page.getByText("Send it to Mum to choose")).toBeVisible();
  const mumToken = await invite(page, t.taskId, t.token, ["requester", "chooser"]);
  const mum = await asOther(browser, t.taskId, mumToken);
  await expect(mum.p.getByText("Send to Mum")).toHaveCount(0);
  await mum.p.locator("li.dcard").first().getByRole("button", { name: "Choose this one" }).click();
  await expect(mum.p.getByText("Sent to be paid")).toBeVisible();
  await expect(mum.p.getByRole("button", { name: /Pay with PayPal/ })).toHaveCount(0);
  await expect(mum.p.locator("body")).not.toContainText(/Up to US\$|Total today/);

  const payerToken = await invite(page, t.taskId, t.token, ["payer"]);
  const payer = await asOther(browser, t.taskId, payerToken);
  const first = payer.p.locator("main > section, main > details").first();
  await expect(first).toHaveAccessibleName(/^Pay/);
  await expect(payer.p.getByRole("button", { name: "Pay with PayPal (sandbox)" })).toBeVisible();
  await expect(payer.p.locator("body")).not.toContainText(/requester|chooser/i);
  await mum.ctx.close(); await payer.ctx.close();
});
