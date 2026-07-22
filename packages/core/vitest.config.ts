import { defineConfig } from "vitest/config";

// TEST-M-09 fast unit lane (measured, not asserted).
//
// Benchmarks (INDICATIVE — dev workstation, Linux 6.17 / Node v22.17, NOT a CI
// host; numbers are relative, not CI-authoritative):
//   - whole suite serialized (singleFork):  47.7s  EXIT 0  (156 files / 4800 tests)
//   - whole suite parallel forks:            37.3-38.4s EXIT 0  (156 / 4800, all green)
// The previously-documented RPC-timeout / OOM fear did NOT reproduce on this box:
// every one of the 4800 tests passes under default fork parallelism, ~20% faster.
// The ECONNRESET / journal-swallow stderr in the parallel run is expected
// recoverable-error fixture output, not test failures.
//
// Shape: two projects. The DEFAULT project ("unit") runs in the parallel fork
// pool — the fast lane. A serial "heavy" project isolates the handful of files
// that load full provider/graph runtime modules at import time (@langchain/anthropic,
// @langchain/openai, @langchain/langgraph); these are the exact files the original
// singleFork rationale worried about on slow/NTFS CI hosts, so they keep a single
// serialized fork as a conservative hedge even though they passed parallel here.
// isolate:true (default) gives every file a fresh module registry either way, so
// cross-file state bleed is not a risk in either project.

const HEAVY_TESTS = [
  "src/formats/__tests__/formats.test.ts", // @langchain/anthropic + @langchain/openai
  "src/persistence/__tests__/checkpointer.test.ts", // @langchain/langgraph MemorySaver
  "src/__tests__/run-context-transfer.test.ts", // @langchain/langgraph InMemoryStore
];

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    hookTimeout: 60_000,
    testTimeout: 120_000,
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
      // Thresholds managed centrally in coverage-thresholds.json.
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Fast parallel lane: default fork pool, one file per fork, all forks
          // concurrent. Excludes the heavy runtime-graph files (run serially below).
          pool: "forks",
          include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", ...HEAVY_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "heavy",
          // Serial island: single fork, no file parallelism. Isolates heavy
          // @langchain provider/graph module inits from the parallel pool.
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
          include: HEAVY_TESTS,
        },
      },
    ],
  },
});
