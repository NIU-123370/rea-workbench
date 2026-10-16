import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
});
