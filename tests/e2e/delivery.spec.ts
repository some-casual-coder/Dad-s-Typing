import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/x");
url.pathname = `/${process.env.TEST_DB_NAME ?? "dads_typing_test"}`;

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("delivered-to-Kenya cards: pickup by default, door on request, price, date, choose", async ({ page }) => {
  // No external search, so the only import offer is the fixture below
  const made = await page.request.post("/api/tasks", { data: { title: "Cat carrier", starterRoles: ["requester", "chooser", "payer"], seedExternal: false } });
  const { taskId, token } = await made.json();
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    const specs = { weightGrams: 1200, lengthMm: 450, widthMm: 300, heightMm: 280, brand: "Fixture" };
    await db.query(
      `INSERT INTO offers (id,task_id,source,source_offer_id,route,seller,title,unit_price_minor,currency,availability,url,specs)
       VALUES ($1,$2,'channel3','E2E-1','external','amazon.com','Fixture cat carrier',3000,'USD','InStock','https://www.amazon.com/dp/B012345678',$3)`,
      [randomUUID(), taskId, JSON.stringify(specs)]);
  } finally { await db.end(); }
  await page.goto("/");
  await page.evaluate(([id, t]) => sessionStorage.setItem(`dt:token:${id}`, t), [taskId, token]);
  await page.goto(`/t/${taskId}`);

  const panel = page.getByRole("region", { name: "Delivered to Kenya" });
  await expect(panel).toBeVisible();
  // No form by default: one question with a default
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByText("Collect it in Nairobi at no extra cost?")).toBeVisible();
  await panel.getByRole("button", { name: "Yes, I'll collect" }).click();
  await expect(panel.getByText("You collect it in")).toBeVisible();
  const pickupPrice = await panel.locator("li.dcard", { hasText: "Fixture cat carrier" }).locator(".price").textContent();
  // Door delivery is one tap and a town away, and costs more
  await panel.getByRole("button", { name: "Deliver to my door instead" }).click();
  await panel.getByLabel("Town or area to deliver to").fill("Kilimani");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByText("Delivering to your door in")).toBeVisible();
  await expect(panel.locator("li.dcard", { hasText: "Fixture cat carrier" }).locator(".price")).not.toHaveText(pickupPrice!);

  const card = panel.locator("li.dcard", { hasText: "Fixture cat carrier" });
  await expect(card).toContainText(/KSh [\d,]+/);
  await expect(card).toContainText(/Arrives about \d+/);
  await expect(panel.getByText(/^I'd get the first one|None of these/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await card.getByText("Details").click();
  await expect(card).toContainText("Source:");
  await expect(card.getByRole("link", { name: "Provider tracking" })).toHaveAttribute("href", /kentexcargo\.com\/tracking/);

  await card.getByRole("button", { name: "Choose this one" }).click();
  await expect(page.getByRole("heading", { name: /Chosen: Fixture cat carrier/ })).toBeVisible();
});
