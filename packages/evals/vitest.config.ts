import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Contract tests spin up real adapters (MockSandbox, InMemoryVectorStore)
    // and their dynamic imports can exceed 90s under the full release gate.
    // Run sequentially so they do not starve each other under the default pool.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/__tests__/**",
        "src/**/__fixtures__/**",
        "src/**/index.ts",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 50,
        lines: 60,
      },
    },
  },
});
