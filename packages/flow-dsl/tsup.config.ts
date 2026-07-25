import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/dsl-source-map.ts',
    'src/v2-policy-narrowing.ts',
    'src/v2-retry-policy.ts',
    'src/v2-terminal-catch.ts',
    'src/v2-multi-port-save.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
