import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    unstubEnvs: true,
    unstubGlobals: true,
    globals: false,
    environment: "node",
    // DZUPAGENT-TEST-L-08: was 300_000/120_000, masking hangs for minutes.
    // Slow tests must opt in explicitly via `it('...', fn, { timeout: N })`.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // TEST-M-09: vmThreads multi-thread (fast lane), measured — the previously
    // asserted singleThread rationale (arch scan ~58s / onTaskUpdate RPC timeout)
    // did NOT reproduce; parallel vmThreads is substantially faster with
    // identical results. Benchmarks (INDICATIVE — dev workstation, Linux 6.17 /
    // Node v22.17, NOT a CI host; relative, not CI-authoritative), 17 files:
    //   - singleThread (old):  10.72s   (341/343 pass — 2 pre-existing arch-boundary
    //                                     failures, unrelated to pool config)
    //   - parallel vmThreads:   4.55s   (identical 341/343 — ~58% faster)
    // Measured 2026-07-22 (last recorded in git); review-by 2026-10-22 (DZUPAGENT-TEST-L-11).
    // vmThreads (not forks) is kept because the workspace scan uses Node.js
    // built-in fs APIs that are thread-safe and avoid fork startup overhead.
    pool: "vmThreads",
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
        // Type-only modules: no runtime statements/branches/functions exist
        // to cover. v8 still counts these files as 0%, dragging the package
        // average down for files that can never be "tested" — excluding
        // them is a coverage-scope correction, not a real-coverage gap.
        "src/eval/types.ts",
        "src/security/security-test-types.ts",
        // CLI entrypoint shim: `main()` runs unconditionally at module load
        // (no `readArgValue`/`printHelp` exports, no import.meta guard), so
        // importing it for a unit test would execute the CLI itself. Its
        // only non-trivial logic (arg parsing) is a few lines that delegate
        // straight to `shapeSdlcMvpEvidenceCommandOutputs` /
        // `runSdlcMvpEvidenceReport`, both fully covered by
        // sdlc-mvp-evidence.test.ts. Excluded as a documented decision, not
        // a silent omission — DZUPAGENT-TEST-C-15 coverage gap closeout.
        "src/bin/sdlc-mvp-evidence.ts",
      ],
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 30,
        lines: 40,
      },
    },
  },
});
