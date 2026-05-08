import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/vitest-llm-setup.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
