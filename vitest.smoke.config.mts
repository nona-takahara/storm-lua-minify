import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/smoke/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 5_000,
    hookTimeout: 5_000,
  },
});
