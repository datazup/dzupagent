import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/vitest-llm-setup.ts', 'src/bin/sdlc-mvp-evidence.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
