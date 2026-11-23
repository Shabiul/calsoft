import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import path from "node:path";
config({ path: ".env.local" });
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    // Test users live on these domains; outsider.test is deliberately NOT allowed (company-domain gate tests).
    env: { ALLOWED_EMAIL_DOMAINS: "example.test,example.com" },
    setupFiles: ["tests/setup-guard.ts"], include: ["src/**/*.test.ts", "tests/**/*.test.ts"], testTimeout: 30000, fileParallelism: false },
});
