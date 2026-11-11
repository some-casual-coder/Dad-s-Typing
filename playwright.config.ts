import { defineConfig } from "@playwright/test";

try { process.loadEnvFile(".env.local"); } catch { /* env may come from the shell */ }
const PORT = 3101;
const db = new URL(process.env.DATABASE_URL ?? "postgres://localhost/x");
db.pathname = `/${process.env.TEST_DB_NAME ?? "dads_typing_test"}`;

// Runs against a production build, system Chrome, the configured live provider
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, channel: "chrome", trace: "off" },
  webServer: {
    command: `next build && next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-a",
      APP_BASE_URL: `http://localhost:${PORT}`,
      DATABASE_URL: db.toString(),
    },
  },
});
