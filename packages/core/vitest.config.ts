import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    hookTimeout: 60_000,
    testTimeout: 120_000,
    // Core pulls in broad facade, LangChain, MCP, and vector-store modules.
    // Under the full Turbo gate, parallel workers can starve long enough for
    // Vitest RPC fetch/onTaskUpdate calls to time out. Use one forked worker
    // so module loading stays deterministic under repository-wide contention.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
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
