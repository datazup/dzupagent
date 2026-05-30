import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false, exactOptionalPropertyTypes: false } },
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
