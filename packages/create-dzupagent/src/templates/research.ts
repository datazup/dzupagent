import type { TemplateManifest } from '../types.js'

export const researchTemplate: TemplateManifest = {
  id: 'research',
  name: 'Research Agent',
  description: 'Research agent with web search, RAG, and report synthesis.',
  files: [
    {
      path: 'package.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'tsx watch src/server.ts',
            start: 'node dist/server.js',
            build: 'tsc',
            test: 'vitest run',
            typecheck: 'tsc --noEmit',
          },
          dependencies: {
            '@dzupagent/agent': '^0.2.0',
            '@dzupagent/core': '^0.2.0',
            '@dzupagent/express': '^0.2.0',
            '@langchain/anthropic': '^1.3.0',
            express: '^4.21.0',
          },
          devDependencies: {
            tsx: '^4.0.0',
            typescript: '^5.8.0',
            vitest: '^3.0.0',
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
      path: 'src/agent.ts',
      templateContent: `// {{projectName}} — research agent
import { DzupAgent } from '@dzupagent/agent'
import { ChatAnthropic } from '@langchain/anthropic'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'

const webSearchTool = new DynamicStructuredTool({
  name: 'web_search',
  description: 'Search the web for current information',
  schema: z.object({ query: z.string().describe('Search query') }),
  func: async ({ query }) => \`Search results for: \${query} (implement with your search API)\`,
})

const synthesizeReportTool = new DynamicStructuredTool({
  name: 'synthesize_report',
  description: 'Synthesize research findings into a structured report',
  schema: z.object({
    topic: z.string(),
    findings: z.array(z.string()),
  }),
  func: async ({ topic, findings }) =>
    \`# Report: \${topic}\\n\\n\${findings.map((f, i) => \`\${i + 1}. \${f}\`).join('\\n')}\`,
})

export function createResearchAgent() {
  return new DzupAgent({
    name: '{{projectName}}',
    model: new ChatAnthropic({
      model: 'claude-sonnet-4-5-20251001',
      apiKey: process.env.ANTHROPIC_API_KEY,
    }),
    tools: [webSearchTool, synthesizeReportTool],
    systemPrompt: \`You are a research agent. Your job is to research topics thoroughly,
gather evidence from multiple sources, and synthesize findings into clear reports.
Always cite your sources and assess evidence quality.\`,
  })
}
`,
    },
    {
      path: 'src/server.ts',
      templateContent: `// {{projectName}} — research agent server
import { createAgentRouter, createSSEStream } from '@dzupagent/express'
import express from 'express'
import { createResearchAgent } from './agent.js'

const app = express()
app.use(express.json())

const agent = createResearchAgent()
app.use('/api/agent', createAgentRouter(agent))
app.get('/api/stream', createSSEStream(agent))

const port = parseInt(process.env.PORT ?? '3000', 10)
app.listen(port, () => {
  console.log(\`Research agent server running on port \${port}\`)
})
`,
    },
    {
      path: '.env.example',
      templateContent: `# {{projectName}} environment variables
ANTHROPIC_API_KEY=your_anthropic_api_key_here
PORT=3000
# Optional: OpenAI API key for embeddings
# OPENAI_API_KEY=your_openai_api_key_here
# Optional: GitHub connector
# GITHUB_TOKEN=your_github_token_here
# Optional: Slack notifications
# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
`,
    },
    {
      path: 'dzupagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.1.0',
          server: { port: 3000 },
        },
        null,
        2,
      ),
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
    '@dzupagent/agent': '^0.2.0',
    '@dzupagent/core': '^0.2.0',
    '@dzupagent/express': '^0.2.0',
    '@dzupagent/rag': '^0.2.0',
    '@dzupagent/connectors': '^0.2.0',
    '@langchain/anthropic': '^1.3.0',
    'express': '^4.21.0',
  },
  devDependencies: {
    typescript: '^5.8.0',
    tsx: '^4.0.0',
    vitest: '^3.0.0',
  },
}
