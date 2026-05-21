import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/vfs.ts', 'src/tools.ts', 'src/runtime.ts', 'src/compat.ts'],
  format: ['esm'],
  // Keep tsup on JS bundling only; declaration bundling is slow for this multi-entry graph.
  // The package build emits declarations with tsc after tsup, matching core/server.
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
  external: ['@dzupagent/core', 'web-tree-sitter'],
})
