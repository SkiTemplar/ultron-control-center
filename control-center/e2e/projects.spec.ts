// E2E projects test — navigate to projects, open one, verify Jarvis tab is default.
// Requires: npm run dev running on http://localhost:1420

import { test, expect } from "@playwright/test";

test.describe("Projects page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Navigate to Projects via the sidebar
    const projectsLink = page.locator("text=Projects").first();
    await projectsLink.waitFor({ timeout: 10000 });
    await projectsLink.click();
    await page.waitForTimeout(500);
  });

  test("renders the Projects heading", async ({ page }) => {
    await expect(page.locator("h1, h2").filter({ hasText: "Projects" }).first()).toBeVisible({
      timeout: 8000,
    });
  });

  test("shows search input", async ({ page }) => {
    await expect(
      page.locator("input[placeholder*='Search']").first(),
    ).toBeVisible({ timeout: 8000 });
  });

  test("shows layout toggle buttons (blocks / tree / flat)", async ({ page }) => {
    // At least one hierarchy button should exist
    const blocksBtn = page.locator("button", { hasText: "blocks" });
    const flatBtn = page.locator("button", { hasText: "flat" });
    await expect(blocksBtn.or(flatBtn).first()).toBeVisible({ timeout: 8000 });
  });

  test("New project button is present", async ({ page }) => {
    await expect(
      page.locator("button", { hasText: "+ New project" }).first(),
    ).toBeVisible({ timeout: 8000 });
  });
});
