import type { TemplateManifest } from '../types.js'

export const minimalTemplate: TemplateManifest = {
  id: 'minimal',
  name: 'Minimal Agent',
  description: 'A bare-bones single-agent project with no server or persistence.',
  files: [
    {
      path: 'package.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          version: '0.2.0',
          type: 'module',
          scripts: {
            build: 'tsup',
            start: 'node dist/index.js',
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
      templateContent: `// {{projectName}} — minimal DzupAgent project
import { DzupAgent } from '@dzupagent/agent'

const agent = new DzupAgent({
  name: '{{projectName}}',
  instructions: 'You are a helpful assistant.',
})

console.log('Agent created:', agent.name)
`,
    },
    {
      path: 'dzupagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.2.0',
        },
        null,
        2,
      ),
    },
    {
      path: '.env.example',
      templateContent: `# {{projectName}} environment variables
ANTHROPIC_API_KEY=your-api-key-here
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
    '@dzupagent/core': '^0.2.0',
    '@dzupagent/agent': '^0.2.0',
  },
  devDependencies: {
    typescript: '^5.4.0',
    tsup: '^8.0.0',
  },
}
