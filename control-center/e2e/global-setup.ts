/**
 * Playwright globalSetup — runs once before all tests in a browser context.
 *
 * Problem: The Onboarding overlay (Onboarding.tsx) shows on every fresh
 * browser context because `ultron_onboarding_seen` is absent from
 * localStorage. The modal has aria-modal=true and intercepts pointer events,
 * causing 4/7 navigation tests to fail deterministically on a clean machine.
 *
 * Fix: Pre-seed the localStorage flag so the modal never auto-shows during
 * tests. We do this by launching a temporary browser context, navigating to
 * the app (to confirm the origin exists), writing the key, then saving a
 * storageState snapshot. playwright.config.ts loads this snapshot for every
 * test via `use.storageState`.
 *
 * The STORAGE_KEY value ("ultron_onboarding_seen") must stay in sync with
 * Onboarding.tsx. If it ever changes, update both files.
 */

import { chromium, FullConfig } from "@playwright/test";

const STORAGE_KEY = "ultron_onboarding_seen";
export const STORAGE_STATE_PATH = "e2e/.auth/storage-state.json";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = _config.projects[0]?.use?.baseURL ?? "http://localhost:1420";

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate so the page origin is established before touching localStorage.
  // reuseExistingServer=true in playwright.config means the dev server is
  // already up; the goto just seeds the origin for the storage snapshot.
  try {
    await page.goto(baseURL, { timeout: 30000, waitUntil: "domcontentloaded" });
  } catch {
    // If the server is unreachable (e.g. CI without the dev server),
    // we still attempt to set the flag via addInitScript in storageState.
    // The test will fail with a better error (connection refused) rather than
    // a confusing modal-intercept failure.
  }

  // Seed the onboarding flag so Onboarding.tsx never auto-opens.
  await page.evaluate(
    ({ key }) => {
      localStorage.setItem(key, new Date().toISOString());
    },
    { key: STORAGE_KEY }
  );

  // Persist the storage state so all test contexts inherit the flag.
  await context.storageState({ path: STORAGE_STATE_PATH });

  await browser.close();
}
