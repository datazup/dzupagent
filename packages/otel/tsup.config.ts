import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/agent-loop.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
