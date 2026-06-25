import { defineConfig } from "vitest/config";

// When RUN_REQUIRED_INTEGRATION=1 is set (via `yarn test:required-integration`),
// integration suites that call skipOrFailIfNoDatabase() / skipOrFailIfNoContainerRuntime()
// will throw instead of silently skipping — ensuring CI fails loudly when the
// required service (Postgres, Redis, Docker) is absent rather than reporting a
// false-green run.  See src/__tests__/helpers/require-integration.ts.
export default defineConfig({
  test: {
    pool: "forks",
    globals: false,
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    include: ["src/__tests__/*.integration.test.ts"],
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
    },
  },
});
