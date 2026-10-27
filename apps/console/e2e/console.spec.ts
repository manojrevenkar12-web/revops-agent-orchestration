import { expect, test } from "@playwright/test";

test("the overview shows each automation and who decided its cases", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What the automations did" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Inbound leads:/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Deal registrations:/ })).toBeVisible();
  await page.waitForTimeout(1500); // let the lanes finish growing
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
});

test("a renewal case shows the path it took on the BPMN diagram and its audit trail", async ({ page }) => {
  await page.goto("/instances?process=renewal-risk-save-play");
  await page.getByRole("link").filter({ hasText: /^\d+$/ }).first().click();
  await expect(page.locator(".diagram .djs-container svg").first()).toBeVisible();
  await expect(page.locator(".diagram g.m-done").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible();
  await page.screenshot({ path: "test-results/case.png", fullPage: true });
});

test("waiting decisions are listed and open the case they belong to", async ({ page }) => {
  await page.goto("/approvals");
  const first = page.locator("tbody tr").first();
  await expect(first).toBeVisible();
  await first.getByRole("link").click();
  await expect(page.locator(".diagram g.m-active").first()).toBeVisible();
});

test("the audit log verifies its hash chain, and the tool catalogue marks writes", async ({ page }) => {
  await page.goto("/audit");
  await expect(page.getByText("chain intact")).toBeVisible();
  await page.goto("/catalogue");
  await expect(page.getByRole("row", { name: /crm_upsert_lead/ }).getByText("needs an approval")).toBeVisible();
  await expect(page.getByRole("row", { name: /account_360/ }).getByText("read only")).toBeVisible();
});
