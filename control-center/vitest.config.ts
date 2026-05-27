import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Exclude Playwright E2E specs — those run via `npm run test:e2e` only
    exclude: ["e2e/**", "node_modules/**"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
