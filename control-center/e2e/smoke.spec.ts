// E2E smoke test — open app, verify sidebar items present, no console errors.
// Requires: npm run dev running on http://localhost:1420

import { test, expect } from "@playwright/test";

test.describe("App smoke", () => {
  const consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors.length = 0;
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.goto("/");
  });

  test("loads without JS errors", async ({ page }) => {
    // Wait for the app shell to render
    await page.waitForSelector("body", { timeout: 15000 });
    // Filter out known benign Tauri/browser noise
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes("ResizeObserver") &&
        !e.includes("favicon") &&
        !e.includes("wasm"),
    );
    expect(realErrors).toHaveLength(0);
  });

  test("sidebar navigation items are present", async ({ page }) => {
    await page.waitForSelector("nav, [role='navigation'], aside", { timeout: 10000 });
    // At least one of the known top-level nav items should be visible
    const navText = await page.locator("nav, aside").first().innerText();
    // La barra lateral del Control Center va en inglés (decisión del 2026-10-18).
    for (const item of ["Dashboard", "Usage", "Projects", "Settings"]) {
      expect(navText).toContain(item);
    }
  });

  test("page title is set", async ({ page }) => {
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});
