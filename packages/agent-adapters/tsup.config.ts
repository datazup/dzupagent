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
    'src/runs/index.ts',
    'src/integration/index.ts',
    'src/dzupagent/index.ts',
    'src/rules.ts',
    'src/skills.ts',
    'src/enrichment.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  external: [
    /^@dzupagent\//,
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
  ],
});
