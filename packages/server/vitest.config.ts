import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // Stub files for tests moved to app domain packages — no test suites
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/__tests__/ledger-routes.test.ts',
      'src/__tests__/persona-routes.test.ts',
      'src/__tests__/scheduler-routes.test.ts',
      'src/__tests__/workflow-routes.test.ts',
    ],
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
