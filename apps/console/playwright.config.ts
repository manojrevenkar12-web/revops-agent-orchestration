import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:9601", viewport: { width: 1360, height: 900 } },
  webServer: { command: "npx tsx ../../scripts/demo.ts --port 9601", url: "http://127.0.0.1:9601/healthz", timeout: 120_000, reuseExistingServer: false, cwd: "." },
  outputDir: "test-results",
});
