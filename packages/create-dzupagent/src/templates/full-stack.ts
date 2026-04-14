import type { TemplateManifest } from '../types.js'

export const fullStackTemplate: TemplateManifest = {
  id: 'full-stack',
  name: 'Full-Stack Agent',
  description: 'Agent with server, persistence, memory, and context management.',
  files: [
    {
      path: 'package.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          version: '0.1.0',
          type: 'module',
          scripts: {
            build: 'tsup',
            start: 'node dist/index.js',
            dev: 'tsx watch src/index.ts',
            typecheck: 'tsc --noEmit',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      templateContent: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            outDir: 'dist',
            rootDir: 'src',
            declaration: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      templateContent: `// {{projectName}} — full-stack DzupAgent project
import { createForgeApp } from '@dzupagent/server'

const app = createForgeApp({
  auth: { mode: 'none' },
})

export default { port: 4000, fetch: app.fetch }
console.log('{{projectName}} server running on port 4000')
`,
    },
    {
      path: 'dzupagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.1.0',
          server: { port: 4000 },
          database: { provider: 'postgres' },
        },
        null,
        2,
      ),
    },
    {
      path: '.env.example',
      templateContent: `# {{projectName}} environment variables
ANTHROPIC_API_KEY=your-api-key-here
DATABASE_URL=postgresql://user:password@localhost:5432/{{projectName}}
PORT=4000
`,
    },
    {
      path: '.gitignore',
      templateContent: `node_modules/
dist/
.env
*.tsbuildinfo
`,
    },
  ],
  dependencies: {
    '@dzupagent/core': '^0.1.0',
    '@dzupagent/agent': '^0.1.0',
    '@dzupagent/server': '^0.1.0',
    '@dzupagent/memory': '^0.1.0',
    '@dzupagent/context': '^0.1.0',
  },
  devDependencies: {
    typescript: '^5.4.0',
    tsup: '^8.0.0',
    tsx: '^4.0.0',
  },
}
