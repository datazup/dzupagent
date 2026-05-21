import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/vfs.ts', 'src/tools.ts', 'src/runtime.ts', 'src/compat.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
  external: ['@dzupagent/core', 'web-tree-sitter'],
})
