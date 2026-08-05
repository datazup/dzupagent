import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/route-error-public.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
