import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const REEL = "https://www.instagram.com/reel/C9abcDEF123/?igsh=abc";

test("R08: a preview crawler gets a generic page with no task data and no side effects", async ({ page, request }) => {
  const made = await (await request.post("/api/tasks", { data: { title: "Secret birthday gift for Mum", starterRoles: ["requester", "chooser", "payer"], seedExternal: false } })).json();
  for (const method of ["GET", "HEAD"] as const) {
    const r = await request.fetch(`/t/${made.taskId}`, { method });
    expect(r.status()).toBe(200);
    if (method === "GET") {
      const html = await r.text();
      expect(html).toContain("Dad&#x27;s Typing — Open a shopping task");
      expect(html).not.toContain("Secret birthday");
      expect(html).toMatch(/noindex/);
    }
  }
  const events = await request.get(`/api/tasks/${made.taskId}/sources`, { headers: { authorization: `Bearer ${"x".repeat(32)}` } });
  expect([401, 403, 404]).toContain(events.status());
  await page.goto("/");
});

test("R10: paste a Reel link on a phone, see an honest source card, recover with a description", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("What are you looking for?").fill(REEL);
  await page.getByRole("button", { name: "Start for me" }).click();
  await page.waitForURL(/\/t\/[0-9a-f-]+/);
  const card = page.getByRole("region", { name: "Which item?" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Instagram", { exact: true })).toBeVisible();
  await expect(card.getByText(/I can't read the video from a link/)).toBeVisible();
  const open = card.getByRole("link", { name: "Open original" });
  await expect(open).toHaveAttribute("href", "https://www.instagram.com/reel/C9abcDEF123/");
  await expect(open).toHaveAttribute("rel", /noopener/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Shared Instagram post");
  // Keyboard reaches the recovery actions
  await card.getByLabel("Describe the item").focus();
  await page.keyboard.type("white folding table");
  await page.keyboard.press("Enter");
  // The description names the item (live model), so the page moves on to Choose
  // and the link shrinks to one line that still holds the evidence
  const line = page.getByText("From your Instagram post · Change item");
  await expect(line).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("region", { name: "Delivered to Kenya" })).toBeVisible();
  await line.click();
  await expect(page.getByText("Your words")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
