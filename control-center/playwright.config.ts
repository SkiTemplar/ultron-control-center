import { defineConfig } from "@playwright/test";

// Path must stay in sync with STORAGE_STATE_PATH in e2e/global-setup.ts.
const STORAGE_STATE = "e2e/.auth/storage-state.json";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // Run global-setup once before the test suite to pre-seed localStorage with
  // `ultron_onboarding_seen`, preventing the Welcome modal from intercepting
  // pointer events during navigation tests (cat18.2 fix).
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:1420",
    headless: true,
    // All test contexts start with the onboarding flag already set.
    storageState: STORAGE_STATE,
  },
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
