import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/expressions.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
