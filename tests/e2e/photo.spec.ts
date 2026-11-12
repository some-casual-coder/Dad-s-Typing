import { expect, test, type Page } from "@playwright/test";

const PNG = "tests/fixtures/carrier.png";
const JPG = "tests/fixtures/carrier.jpg";

function track(page: Page) {
  const calls = { tasks: 0, messages: 0 };
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const u = new URL(r.url());
    if (u.pathname === "/api/tasks") calls.tasks++;
    if (/^\/api\/tasks\/[^/]+\/messages$/.test(u.pathname)) calls.messages++;
  });
  return calls;
}

async function choose(page: Page, name: string, files: string | { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser"); // armed before the click
  await page.getByRole("button", { name }).click();
  await (await chooser).setFiles(files);
}

test("home Upload photo: preview, send, first AI result in the task", async ({ page }) => {
  const calls = track(page);
  await page.goto("/");
  await page.getByLabel("What are you looking for?").fill("a cat carrier");
  await choose(page, "Upload photo", PNG);
  const img = page.getByRole("img", { name: /Photo you are about to send/ });
  await expect(img).toBeVisible();
  await page.getByLabel("Describe the photo (optional)").fill("grey carrier with a front door");
  await expect(page.getByRole("img", { name: "grey carrier with a front door" })).toBeVisible();
  await page.getByLabel("Add a note (optional)").fill("Mum wants one like this");
  await page.getByRole("button", { name: "Start with this photo" }).click();
  await page.waitForURL(/\/t\/[0-9a-f-]+/);
  const msgs = page.getByRole("list", { name: "Messages" });
  await expect(msgs.getByText("(photo attached)")).toBeVisible();
  const reply = msgs.locator("li.assistant p");
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(reply).not.toHaveText(/could not read that/);
  expect(calls).toEqual({ tasks: 1, messages: 1 });
});

test("cancelling the chooser creates no task or message", async ({ page }) => {
  const calls = track(page);
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload photo" }).click();
  await (await chooser).setFiles([]);
  await expect(page.getByRole("img", { name: /Photo you are about to send/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start with this photo" })).toHaveCount(0);
  expect(calls).toEqual({ tasks: 0, messages: 0 });
});

test("wrong format is refused with copy; server-rejected bytes retry safely", async ({ page }) => {
  const calls = track(page);
  await page.goto("/");
  await choose(page, "Upload photo", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.locator("p.error")).toContainText("JPEG, PNG or WebP");
  await expect(page.getByRole("button", { name: "Start with this photo" })).toHaveCount(0);
  expect(calls.tasks).toBe(0);

  // claims PNG but is not: only the server can tell
  await choose(page, "Upload photo", { name: "fake.png", mimeType: "image/png", buffer: Buffer.from("not really a png") });
  await page.getByRole("button", { name: "Start with this photo" }).click();
  await expect(page.locator("p.error")).toContainText("not a JPEG, PNG or WebP photo");
  await expect(page.locator("p.error")).toContainText("type instead");

  await choose(page, "Replace photo", JPG);
  await page.getByRole("button", { name: "Start with this photo" }).click();
  await page.waitForURL(/\/t\/[0-9a-f-]+/);
  // The reply may sit in the collapsed conversation once options show
  await expect(page.getByRole("list", { name: "Messages" }).locator("li.assistant p").first()).toBeAttached({ timeout: 60_000 });
  expect(calls.tasks).toBe(1); // the failed attempt's task was reused
});

test("composer: remove, replace, same-file reselect, typed fallback, keyboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start for Mum" }).click();
  await page.getByRole("link", { name: "Open the task" }).click();
  await page.waitForURL(/\/t\/[0-9a-f-]+/);
  // Once options exist the conversation is one bar; open it to compose
  const bar = page.locator("details.chatbar > summary");
  await bar.or(page.getByRole("button", { name: "Add photo" })).first().waitFor();
  if (await bar.count()) await bar.click();
  const calls = track(page);

  await choose(page, "Add photo", PNG);
  await expect(page.getByRole("img", { name: /Photo you are about to send/ })).toBeVisible();
  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByRole("img", { name: /Photo you are about to send/ })).toHaveCount(0);
  await choose(page, "Add photo", PNG); // same file again works after reset
  await expect(page.getByRole("img", { name: /Photo you are about to send/ })).toBeVisible();
  await choose(page, "Replace photo", JPG);
  await expect(page.getByRole("img", { name: /carrier\.jpg/ })).toBeVisible();

  // keyboard: the picker button is reachable and opens the chooser on Enter
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Replace photo" }).focus();
  await page.keyboard.press("Enter");
  await (await chooser).setFiles([]);
  await expect(page.getByRole("img", { name: /carrier\.jpg/ })).toBeVisible();
  expect(calls.messages).toBe(0);

  await page.getByRole("button", { name: "Remove photo" }).click();
  await page.getByLabel("Your message").fill("It must open from the top");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The reply may sit in the collapsed conversation once options show
  await expect(page.getByRole("list", { name: "Messages" }).locator("li.assistant p").first()).toBeAttached({ timeout: 60_000 });
});
