import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/monitoring/installation.ts',
    'src/monitoring/health.ts',
    'src/monitoring/lifecycle.ts',
    'src/monitoring/posture.ts',
    'src/monitoring/dashboard.ts',
    'src/provider-session.ts',
    'src/provider-session-explorer.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
