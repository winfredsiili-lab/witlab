import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/testing/globalSetup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
