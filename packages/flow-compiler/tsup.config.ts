import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'node20',
    sourcemap: true,
  },
  {
    entry: { 'bin/compile': 'bin/compile.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    target: 'node20',
    sourcemap: true,
  },
])
