import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import path from "node:path";
config({ path: ".env.local" });
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"], testTimeout: 30000, fileParallelism: false },
});
