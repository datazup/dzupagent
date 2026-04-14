import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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
