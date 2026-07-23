import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/orchestration.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
