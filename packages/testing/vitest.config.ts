import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // The architecture test scans all app workspaces (~58s under load).
    // Run in a single thread-based worker so all test files share one process
    // and the IPC heartbeat between the runner and the thread worker is fast
    // enough to avoid Vitest's "Timeout calling onTaskUpdate" RPC error.
    pool: 'vmThreads',
    poolOptions: { vmThreads: { singleThread: true } },
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
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 30,
        lines: 40,
      },
    },
  },
});
