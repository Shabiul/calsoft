import { defineConfig, devices } from "@playwright/test";

// E2E runs against an already-running production build (see docs/TESTING.md).
// Default port 3205; override with E2E_BASE_URL. Browser: system Edge (no bundled browsers needed);
// set E2E_CHANNEL="" to use bundled chromium after `npx playwright install chromium`.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3205";
const channel = process.env.E2E_CHANNEL === undefined ? "msedge" : process.env.E2E_CHANNEL || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // tests share the dev DB and worker
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", timezoneId: "UTC", locale: "en-US" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel } }],
  webServer: process.env.E2E_START_SERVER
    ? { command: "npx next start -p 3205", url: `${baseURL}/api/health`, reuseExistingServer: true, timeout: 120_000 }
    : undefined,
});
