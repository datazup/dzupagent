import type { TemplateManifest } from '../types.js'

export const codegenTemplate: TemplateManifest = {
  id: 'codegen',
  name: 'Code Generation Agent',
  description: 'Agent specialized for code generation with git tools and VFS.',
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
      templateContent: `// {{projectName}} — codegen ForgeAgent project
import { ForgeAgent } from '@forgeagent/agent'

const agent = new ForgeAgent({
  name: '{{projectName}}',
  instructions: 'You are a code generation assistant. Generate clean, typed code.',
  tools: ['file-write', 'file-read', 'git-commit'],
})

console.log('Codegen agent created:', agent.name)
`,
    },
    {
      path: 'forgeagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.1.0',
          codegen: { vfs: true, gitTools: true },
        },
        null,
        2,
      ),
    },
    {
      path: '.env.example',
      templateContent: `# {{projectName}} environment variables
ANTHROPIC_API_KEY=your-api-key-here
WORKSPACE_DIR=./workspace
`,
    },
    {
      path: '.gitignore',
      templateContent: `node_modules/
dist/
.env
*.tsbuildinfo
workspace/
`,
    },
  ],
  dependencies: {
    '@forgeagent/core': '^0.1.0',
    '@forgeagent/agent': '^0.1.0',
    '@forgeagent/codegen': '^0.1.0',
  },
  devDependencies: {
    typescript: '^5.4.0',
    tsup: '^8.0.0',
  },
}
