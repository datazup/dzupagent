import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/agent.ts',
    'src/orchestration.ts',
    'src/self-correction.ts',
    'src/replay.ts',
    'src/pipeline.ts',
    'src/runtime.ts',
    'src/workflow.ts',
    'src/tools.ts',
    'src/compat.ts',
  ],
  format: ['esm'],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
})
