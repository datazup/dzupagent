import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSourceEntry = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));
const corePipelineEntry = fileURLToPath(new URL('../core/src/pipeline.ts', import.meta.url));
const coreUtilsEntry = fileURLToPath(new URL('../core/src/utils.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@dzupagent/core/pipeline', replacement: corePipelineEntry },
      { find: '@dzupagent/core/utils', replacement: coreUtilsEntry },
      { find: '@dzupagent/core', replacement: coreSourceEntry },
    ],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
