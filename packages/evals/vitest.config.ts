import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // singleFork: retained — evals contract tests spin up real in-process
    // adapters (MockSandbox, InMemoryVectorStore) whose dynamic imports each
    // take 10-30 s; running N forks in parallel exhausts CI memory and causes
    // Vitest RPC timeouts observed at >4 parallel workers. Sequential execution
    // in one fork keeps total wall-clock cost predictable (~90 s max).
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
