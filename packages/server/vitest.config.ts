import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    // The *.integration.test.ts files run in the dedicated (forked) integration
    // lane via vitest.integration.config.ts; exclude them here so they are not
    // double-run in the main lane. (TEST-H-01 / TEST-L-04: the former
    // ledger/persona/scheduler stub exclusions were dropped once those zombie
    // stub files were deleted.)
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/**/*.integration.test.ts",
    ],
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
        statements: 70,
        branches: 60,
        functions: 60,
        lines: 70,
      },
    },
  },
});
