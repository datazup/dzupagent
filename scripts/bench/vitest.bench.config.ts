import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/bench/**/*.bench.ts'],
    benchmark: {
      include: ['scripts/bench/**/*.bench.ts'],
    },
  },
});
