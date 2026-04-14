import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: [
      'src/__tests__/chunker.test.ts',
      'src/__tests__/minimal-chunker.test.ts',
    ],
    maxConcurrency: 1,
    fileParallelism: false,
    // Use forked child processes so the heap limit flag is respected.
    // The @langchain/core graph loads ~300-400 MB; default worker heap is too small.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=4096'],
        singleFork: true,
      },
    },
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
        statements: 70,
        branches: 60,
        functions: 60,
        lines: 70,
      },
    },
  },
});
