import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/agent-blueprints.ts',
      'src/v2-inactive-local-target.ts',
      'src/file-import-lock-chain-backend.ts',
    ],
    format: ['esm'],
    dts: false,
    clean: true,
    target: 'node20',
    sourcemap: true,
  },
  {
    entry: {
      'bin/compile': 'bin/compile.ts',
      'bin/qualify-corpus': 'bin/qualify-corpus.ts',
    },
    format: ['esm'],
    dts: false,
    clean: false,
    target: 'node20',
    sourcemap: true,
  },
])
