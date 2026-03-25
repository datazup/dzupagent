import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
  external: [
    'pg',
    'pg-pool',
    'events',
    'stream',
    'net',
    'tls',
    'crypto',
    'dns',
    'fs',
    'path',
    'os',
    'string_decoder',
    'buffer',
    'util',
  ],
})
