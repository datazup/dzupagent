import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    unstubEnvs: true,
    unstubGlobals: true,
    globals: false,
    environment: 'node',
    // DZUPAGENT-TEST-M-17 (QF-77): bounded parallel pool, measured not asserted.
    // Measured 2026-10-17; review-by 2027-01-17.
    // Benchmarks (indicative: same workstation and conditions as agent-adapters;
    // not CI): maxWorkers=6 (this): 11.2s; maxWorkers=31: 7.0s; serial: 44.6s —
    // all 180 files (+1 skipped) / 5981 passed.
    // Cap kept below the uncapped speed because CI runs turbo test
    // --concurrency=4 on a ~12 GB runner; revisit with a CI-runner measurement.
    maxWorkers: 6,
    testTimeout: 60_000,
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
