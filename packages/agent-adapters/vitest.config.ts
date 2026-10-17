import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    unstubEnvs: true,
    unstubGlobals: true,
    globals: false,
    environment: 'node',
    // DZUPAGENT-TEST-M-17 (QF-77): bounded parallel pool, measured not asserted.
    // Measured 2026-10-17; review-by 2027-01-17 — re-run on the CI runner, or
    // move any file that flakes in parallel into a serial "heavy" project (core
    // pattern). The previous serial override (59fd240b, 2026-08-27) gave no
    // reason and its isolation concern did not reproduce.
    // Benchmarks (indicative: 32-core dev workstation under other load, vitest 3,
    // --cache=false; not a CI host):
    //   - serial (fileParallelism:false, maxWorkers:1): 99.9s, 240 files / 4681 passed
    //   - maxWorkers=8: 32.2s / 34.1s; maxWorkers=31: 34.8s — same counts, 0 failed
    // Capped at 6: no gain past ~8 workers, and CI runs turbo test
    // --concurrency=4 on a ~12 GB runner.
    maxWorkers: 6,
    testTimeout: 30_000,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/**/__fixtures__/**',
        'src/**/index.ts',
      ],
      // Thresholds managed centrally in coverage-thresholds.json.
    },
  },
});
