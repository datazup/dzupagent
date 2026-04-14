import type { TemplateManifest } from '../types.js'

export const costConstrainedWorkerTemplate: TemplateManifest = {
  id: 'cost-constrained-worker',
  name: 'Cost-Constrained Worker',
  description: 'Budget-optimized agent with Haiku model, minimal memory, and batch processing.',
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
      templateContent: `// {{projectName}} — cost-constrained worker agent
import { DzupAgent } from '@dzupagent/agent'
import { config } from './config.js'

const agent = new DzupAgent({
  name: '{{projectName}}',
  instructions: 'You are a concise, efficient assistant. Keep responses short and actionable.',
  model: config.model,
  maxTokens: config.maxTokensPerRequest,
})

/**
 * Process a batch of tasks sequentially to minimize concurrent API costs.
 */
async function processBatch(tasks: string[]): Promise<void> {
  console.log(\`Processing batch of \${tasks.length} tasks with \${config.model}\`)

  for (const task of tasks) {
    if (task.length > config.maxInputLength) {
      console.warn(\`Skipping task exceeding max input length (\${task.length} > \${config.maxInputLength})\`)
      continue
    }
    console.log(\`Processing: \${task.slice(0, 80)}...\`)
  }

  console.log('Batch complete')
}

// Example batch
const exampleTasks = [
  'Summarize the quarterly report',
  'Extract action items from meeting notes',
  'Classify support ticket priority',
]

processBatch(exampleTasks).catch(console.error)
`,
    },
    {
      path: 'src/config.ts',
      templateContent: `// {{projectName}} — cost-constrained configuration

export const config = {
  // Model — use Haiku for lowest cost per token
  model: process.env['MODEL'] ?? 'claude-3-haiku-20240307',

  // Aggressive token limits
  maxTokensPerRequest: parseInt(process.env['MAX_TOKENS_PER_REQUEST'] ?? '1024', 10),
  maxTokensPerDay: parseInt(process.env['MAX_TOKENS_PER_DAY'] ?? '100000', 10),

  // Input limits
  maxInputLength: parseInt(process.env['MAX_INPUT_LENGTH'] ?? '4000', 10),

  // Batch processing
  batchSize: parseInt(process.env['BATCH_SIZE'] ?? '10', 10),
  concurrency: parseInt(process.env['CONCURRENCY'] ?? '1', 10),

  // LLM
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',

  // No OTEL, no vector DB, no Redis — minimal overhead
} as const
`,
    },
    {
      path: 'dzupagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.1.0',
          model: 'claude-3-haiku-20240307',
          memory: { provider: 'in-memory' },
          tokenBudget: {
            maxPerRequest: 1024,
            maxPerDay: 100000,
          },
          batch: {
            size: 10,
            concurrency: 1,
          },
        },
        null,
        2,
      ),
    },
    {
      path: '.env.example',
      templateContent: `# {{projectName}} — cost-constrained worker environment

# LLM — defaults to Haiku for lowest cost
ANTHROPIC_API_KEY=your-api-key-here
MODEL=claude-3-haiku-20240307

# Token limits (aggressive defaults)
MAX_TOKENS_PER_REQUEST=1024
MAX_TOKENS_PER_DAY=100000

# Input limits
MAX_INPUT_LENGTH=4000

# Batch processing
BATCH_SIZE=10
CONCURRENCY=1
`,
    },
    {
      path: 'README.md',
      templateContent: `# {{projectName}}

Budget-optimized worker agent built with DzupAgent.

## Design Principles

- **Lowest cost**: Defaults to Claude Haiku for minimal per-token cost
- **Aggressive limits**: 1024 max tokens per request, 100K daily budget
- **Minimal infrastructure**: In-memory store only, no vector DB, no Redis, no OTEL
- **Batch processing**: Sequential task processing to avoid concurrent API costs
- **Single file**: Simple setup with no server or persistence overhead

## Quick Start

\`\`\`bash
# Copy environment file
cp .env.example .env

# Install dependencies
npm install

# Run
npm run dev
\`\`\`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| MODEL | claude-3-haiku-20240307 | LLM model to use |
| MAX_TOKENS_PER_REQUEST | 1024 | Max output tokens per call |
| MAX_TOKENS_PER_DAY | 100000 | Daily token budget |
| BATCH_SIZE | 10 | Tasks per batch |
| CONCURRENCY | 1 | Parallel task limit |

## When to Use

- High-volume, low-complexity tasks (classification, extraction, summarization)
- Budget-sensitive environments
- Prototyping and testing before scaling up
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
  },
  devDependencies: {
    typescript: '^5.4.0',
    tsup: '^8.0.0',
    tsx: '^4.0.0',
  },
}
