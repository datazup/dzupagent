import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    unstubEnvs: true,
    unstubGlobals: true,
    globals: false,
    environment: "node",
    // DZUPAGENT-TEST-L-08: was 300_000/300_000, masking hangs for 5 minutes.
    // No test in this package needs more than the product-level
    // `testTimeoutMs` fixture values (max 60_000, see sandbox-contracts.test.ts)
    // exercised as *data*, not as the vitest runner timeout. Slow tests must
    // opt in explicitly via `it('...', fn, { timeout: N })`.
    // hookTimeout kept at 60s (not 30s): vectorstore-contracts.test.ts's
    // beforeEach constructs a real InMemoryVectorStore and was observed
    // hitting 30s under this package's own 53-file parallel-fork pool on a
    // 6-core host (not external load) — 60s gives headroom for that without
    // reverting to the original 300s hang-masking ceiling.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // TEST-M-09: parallel fork pool (fast unit lane), measured — the previously
    // asserted singleFork rationale (10-30s dynamic adapter imports exhausting CI
    // memory / RPC timeouts >4 workers) did NOT reproduce.
    // Benchmarks (INDICATIVE — dev workstation, Linux 6.17 / Node v22.17, NOT a
    // CI host; relative, not CI-authoritative), 53 files / 2828 tests:
    //   - singleFork (old):        10.55s  EXIT 0
    //   - parallel forks (this):    5.89s  EXIT 0  (~44% faster, all green)
    // Measured 2026-07-22 (last recorded in git); review-by 2026-10-22 (DZUPAGENT-TEST-L-11).
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
