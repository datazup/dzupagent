import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
