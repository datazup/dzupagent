import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/providers.ts',
    'src/orchestration.ts',
    'src/workflow.ts',
    'src/http.ts',
    'src/persistence.ts',
    'src/learning.ts',
    'src/recovery.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
  external: [
    /^@dzupagent\//,
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
  ],
});
