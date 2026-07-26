import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/orchestration.ts',
    'src/rag.ts',
    'src/agent-review.ts',
    'src/agent-blueprint.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
