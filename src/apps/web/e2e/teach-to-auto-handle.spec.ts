import { expect, test } from "@playwright/test";

test("Teach a refund, activate its draft, and auto-handle a structured arrival with zero tokens", async ({ page, context }) => {
  const forbidden: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://localhost:8098" || (route.request().method() === "POST" && /\/(?:chat|agent-chat|complete|completions)(?:\/|$)/.test(url.pathname))) {
      forbidden.push(`${url.origin}${url.pathname}`);
      await route.abort();
    } else await route.continue();
  });

  await test.step("Sign in through Continue as local dev", async () => {
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Continue as local dev", exact: true }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  });

  await test.step("Teach three real UI mutations on req_0001", async () => {
    await page.locator('a[href="/requests/req_0001"]').click();
    const teach = page.getByRole("region", { name: "Teach", exact: true });
    await teach.getByRole("button", { name: "Teach", exact: true }).click();
    await expect(teach).toHaveAttribute("data-state", "recording");
    await page.getByRole("button", { name: "Order actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Issue refund", exact: true }).click();
    const refund = page.getByRole("dialog", { name: "Issue refund", exact: true });
    await refund.getByLabel("Amount (USD)", { exact: true }).fill("140.00");
    await refund.getByLabel("Reason", { exact: true }).fill("One platter arrived chipped - refund 50% of its price");
    await refund.getByRole("button", { name: "Issue refund", exact: true }).click();
    await expect(refund).toBeHidden();
    await expect(teach).toContainText("1 action");
    await page.getByRole("textbox", { name: "Reply to customer", exact: true }).fill("Hi Maya, I am so sorry your Ember serving platter arrived chipped. We have refunded $140.00, half of its price. Warmly, Kiln & Co.");
    await page.getByRole("button", { name: "Save reply", exact: true }).click();
    await expect(teach).toContainText("2 actions");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    const tag = page.getByRole("dialog", { name: "Add tag", exact: true });
    await tag.getByRole("textbox", { name: "Add tag", exact: true }).fill("damaged");
    await tag.getByRole("button", { name: "Add tag", exact: true }).click();
    await expect(tag).toBeHidden();
    await expect(teach).toContainText("3 actions");
    // Real pointer event also guards the menu/dialog body-lock regression.
    await teach.getByRole("button", { name: "Stop & save", exact: true }).click();
    await expect(teach).toHaveAttribute("data-state", "completed");
    await expect(teach).toContainText("Demonstration saved");
    await expect(teach).toContainText("3 actions");
    await expect(teach.getByRole("list", { name: "Captured actions" }).getByRole("listitem")).toHaveCount(3);
    await teach.getByRole("button", { name: "Create recipe draft", exact: true }).click();
  });

  await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
  const recipePath = new URL(page.url()).pathname;
  await test.step("Review wires and ambiguities, save and explicitly activate v2 without an agent", async () => {
    await expect(page.getByLabel("Binding sources", { exact: true })).toBeVisible();
    await expect(page.locator('.recipe-wire[data-source="trigger"]').first()).toBeVisible();
    await expect(page.locator('.recipe-wire[data-source="formula"]').first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Ambiguities", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save new version", exact: true }).click();
    const history = page.locator(".recipe-history > li").filter({ has: page.locator("summary > span", { hasText: /^v2$/ }) });
    await expect(history).toHaveCount(1);
    await history.locator("summary").first().click();
    await history.getByRole("button", { name: "Activate v2", exact: true }).click();
    await expect(history.locator("summary").first()).toContainText("Active");
    await expect(page.getByText("v2 handles incoming requests", { exact: true })).toBeVisible();
  });

  let requestId = "";
  await test.step("Create one structured damaged-item arrival through the shared action", async () => {
    await page.getByRole("link", { name: "Inbox", exact: true }).click();
    // The demo batch includes free text (extraction). Use the explicitly allowed
    // structured create-request alternative through the app's real frontend client.
    requestId = await page.evaluate(async () => {
      const modulePath = "/node_modules/@agent-native/core/dist/client/hooks/index.js";
      const { callAction } = await import(/* @vite-ignore */ modulePath);
      const request = await callAction("create-request", {
        customerId: "cus_0006", subject: "E2E: chipped sand bowl",
        content: { source: "structured", fields: { type: "damaged_item", orderId: "ord_1006", productId: "prd_0010", quantity: 1, description: "One sand bowl arrived chipped. Please refund half its price." } },
      }, { uiOnly: true });
      return request.id;
    });
    expect(requestId).toMatch(/^req_/);
    expect(requestId).not.toBe("req_0001");
    const row = page.getByRole("listitem").filter({ has: page.locator(`a[href="/requests/${requestId}"]`) });
    await expect(row).toContainText("Damaged item");
    await expect(row).toContainText("Auto-handled");
    await row.getByRole("link", { name: "E2E: chipped sand bowl", exact: true }).click();
    await page.getByRole("link", { name: "View run", exact: true }).click();
  });

  await test.step("Inspect the pinned live run and its computed refund through the UI", async () => {
    await expect(page).toHaveURL(/\/runs\/[^/]+$/);
    await expect(page.locator(".run-metrics")).toContainText("0 LLM tokens");
    await expect(page.locator(".run-page > header")).toContainText("Completed");
    await expect(page.locator(`a[href^="${recipePath}?version="]`)).toContainText("Version 2");
    const refund = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: /Issue refund/ }) });
    await expect(refund).toContainText("Completed");
    // Sand Bowl costs $44; the inferred 50% formula must yield $22, not $140.
    await expect(refund.locator(".run-step-values")).toContainText("$22.00");
    await refund.getByText("Inspect full input & output", { exact: true }).click();
    const evidence = refund.locator("pre");
    await expect(evidence).toHaveCount(2);
    for (const item of await evidence.all()) {
      await expect(item).toContainText('"amountMinor": 2200');
      await expect(item).toContainText('"orderId": "ord_1006"');
    }
    const reply = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: /Save reply/ }) });
    await expect(reply).toContainText("Completed");
    await expect(reply.locator(".run-step-values")).toContainText("Hi Luca");
    await expect(reply.locator(".run-step-values")).toContainText("$22.00");
    const tag = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: /Add tag/ }) });
    await expect(tag).toContainText("Completed");
    await expect(tag.locator(".run-step-values")).toContainText("damaged");
  });

  await test.step("Dashboard counts the same completion as a measured zero-token recipe outcome", async () => {
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.getByText("1 of 1 outcomes", { exact: true })).toBeVisible();
    await page.getByText("Inspect recorded outcomes", { exact: true }).click();
    const outcome = page.getByRole("row").filter({ has: page.getByRole("link", { name: requestId, exact: true }) });
    await expect(outcome.getByRole("cell", { name: "Recipe", exact: true })).toBeVisible();
    await expect(outcome.getByRole("cell").nth(2)).toHaveText(/^0\s*Intake extraction 0 tokens · recipe steps 0 tokens$/);
    await expect(page.locator('[data-handler="recipe"][data-lane="zero"]')).toHaveCount(1);
  });
  expect(forbidden, "No external requests or chat/model calls").toEqual([]);
});
