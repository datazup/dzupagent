import type { TemplateManifest } from '../types.js'

export const multiAgentTemplate: TemplateManifest = {
  id: 'multi-agent',
  name: 'Multi-Agent System',
  description: 'Orchestrated multi-agent system with sub-agents and routing.',
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
      templateContent: `// {{projectName}} — multi-agent DzupAgent project
import { DzupAgent } from '@dzupagent/agent'

const planner = new DzupAgent({
  name: '{{projectName}}-planner',
  instructions: 'You break down complex tasks into sub-tasks.',
})

const executor = new DzupAgent({
  name: '{{projectName}}-executor',
  instructions: 'You execute individual sub-tasks precisely.',
})

console.log('Multi-agent system created:', planner.name, executor.name)
`,
    },
    {
      path: 'src/agents/planner.ts',
      templateContent: `// Planner agent for {{projectName}}
import { DzupAgent } from '@dzupagent/agent'

export function createPlanner(): DzupAgent {
  return new DzupAgent({
    name: '{{projectName}}-planner',
    instructions: 'You are a task planner. Decompose complex requests into steps.',
  })
}
`,
    },
    {
      path: 'dzupagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.2.0',
          agents: {
            planner: { role: 'orchestrator' },
            executor: { role: 'worker' },
          },
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
