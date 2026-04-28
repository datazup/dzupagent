import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/runtime.ts', 'src/workflow.ts', 'src/tools.ts', 'src/compat.ts'],
  format: ['esm'],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
