import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "node_modules/.cache/e2e-results",
  use: {
    baseURL: "http://localhost:8098",
    // guard:allow-env-credential — Non-secret browser selection from the isolated e2e runner.
    channel: process.env.MUSCLE_MEMORY_E2E_BROWSER === "chromium" ? undefined : "chrome",
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
