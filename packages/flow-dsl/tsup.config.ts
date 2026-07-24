import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/dsl-source-map.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
