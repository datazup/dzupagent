import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // TEST-M-09: parallel fork pool (fast unit lane), measured — the previously
    // asserted singleFork rationale (10-30s dynamic adapter imports exhausting CI
    // memory / RPC timeouts >4 workers) did NOT reproduce.
    // Benchmarks (INDICATIVE — dev workstation, Linux 6.17 / Node v22.17, NOT a
    // CI host; relative, not CI-authoritative), 53 files / 2828 tests:
    //   - singleFork (old):        10.55s  EXIT 0
    //   - parallel forks (this):    5.89s  EXIT 0  (~44% faster, all green)
    // isolate:true (default) still gives each file a fresh module registry, so
    // cross-file state bleed is not a risk under parallelism.
    pool: "forks",
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
