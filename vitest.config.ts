import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], env: { DEMO_CATALOGUE: "1", CHANNEL_BURST_MS: "0" }, fileParallelism: false, globalSetup: ["tests/global-setup.ts"] },
});
