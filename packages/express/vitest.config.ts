import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSourceEntry = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dzupagent/core': coreSourceEntry,
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
