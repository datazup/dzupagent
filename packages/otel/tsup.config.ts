import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    tsconfig: 'tsconfig.dts.json',
  },
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
