import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'ops': 'src/ops.ts',
    'runtime': 'src/runtime.ts',
    'compat': 'src/compat.ts',
    'cli/dzup': 'src/cli/dzup.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
  external: [/^@dzupagent\//],
});
