import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
  },
})
