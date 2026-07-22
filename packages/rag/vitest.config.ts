import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    exclude: [],
    maxConcurrency: 1,
    fileParallelism: false,
    // TEST-M-09: singleFork retained — now MEASURED, not merely asserted. rag is
    // a small suite (25 files / 589 tests) where per-fork @langchain/core graph
    // module init (300-400 MB heap) dominates over any parallel gain, so parallel
    // is SLOWER. Benchmarks (INDICATIVE — dev workstation, Linux 6.17 / Node
    // v22.17, NOT a CI host; relative, not CI-authoritative):
    //   - singleFork (this):   2.40s  EXIT 0
    //   - parallel forks:      3.28s  EXIT 0  (SLOWER — fork-init cost wins)
    // singleFork serialises files in one process that already has
    // --max-old-space-size=4096; fileParallelism:false prevents Vitest from
    // attempting concurrent file runs inside that fork.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--max-old-space-size=4096"],
        singleFork: true,
      },
    },
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
