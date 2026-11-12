import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/x");
url.pathname = `/${process.env.TEST_DB_NAME ?? "dads_typing_test"}`;

test("Kenya delivery panel: inputs, handoff, quote import and honest totals", async ({ page }) => {
  // No external search, so the only import offer is the fixture below
  const made = await page.request.post("/api/tasks", { data: { title: "Cat carrier", starterRoles: ["requester", "chooser"], seedExternal: false } });
  const { taskId, token } = await made.json();
  await page.goto("/");
  await page.evaluate(([id, t]) => sessionStorage.setItem(`dt:token:${id}`, t), [taskId, token]);
  await page.goto(`/t/${taskId}`);

  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO offers (id,task_id,source,source_offer_id,route,seller,title,unit_price_minor,currency,availability,url)
       VALUES ($1,$2,'channel3','E2E-1','external','amazon.com','Fixture carrier',3000,'USD','InStock','https://www.amazon.com/dp/B012345678')`,
      [randomUUID(), taskId]);
  } finally { await db.end(); }
  await page.reload();

  const panel = page.getByRole("region", { name: "Getting it to Kenya" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("County").fill("Nairobi");
  await panel.getByLabel("City or area").fill("Westlands");
  await panel.getByRole("button", { name: "Update comparison" }).click();
  await expect(panel.getByText("Saved.")).toBeVisible();

  const kentex = panel.locator("li.offer", { hasText: "Buy from Amazon and ship it for me" });
  await expect(kentex).toContainText("Not a total yet");
  await expect(kentex).not.toContainText("Cheapest delivered");
  await expect(panel.locator("li.offer", { hasText: "Buy and ship it for me" }).first()).toBeVisible();

  await kentex.getByText("How to do this").click();
  await expect(kentex.getByRole("link", { name: /provider/ })).toHaveAttribute("href", /kentexcargo\.com/);
  await expect(kentex).toContainText("paste the exact product link and variant");

  const forward = panel.locator("li.offer", { hasText: "I'll buy it; ship it for me" }).filter({ hasText: "Kentex" });
  await forward.getByText("How to do this").click();
  await expect(forward).toContainText("warehouse address from your own account");
  await expect(forward).toContainText("pre-alert");

  await kentex.getByText("I have a quote").click();
  await kentex.getByLabel("Quote reference").fill("KQ-E2E");
  await kentex.getByLabel("Amount").fill("90");
  for (const t of ["includes the item price", "duties and taxes are included", "includes delivery in Kenya"]) await kentex.getByLabel(new RegExp(t)).check();
  await kentex.getByRole("button", { name: "Add this quote" }).click();
  await expect(kentex).toContainText("Quote KQ-E2E");
  await expect(kentex).toContainText("Estimated total");
  await expect(kentex).toContainText("Included · Item price");
});
