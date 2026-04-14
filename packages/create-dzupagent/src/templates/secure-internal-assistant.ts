import type { TemplateManifest } from '../types.js'

export const secureInternalAssistantTemplate: TemplateManifest = {
  id: 'secure-internal-assistant',
  name: 'Secure Internal Assistant',
  description: 'Corporate internal agent with strict security, audit logging, and encryption.',
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
      templateContent: `// {{projectName}} — secure internal assistant
import { createForgeApp } from '@dzupagent/server'
import { config } from './config.js'

const app = createForgeApp({
  auth: { mode: 'bearer' },
  cors: {
    origin: config.allowedOrigins,
    credentials: true,
  },
})

// All requests require authentication — no public endpoints
console.log(\`{{projectName}} internal assistant running on port \${config.port}\`)
console.log('Security: CORS locked, bearer auth required, audit logging enabled')

export default { port: config.port, fetch: app.fetch }
`,
    },
    {
      path: 'src/config.ts',
      templateContent: `// {{projectName}} — secure internal configuration
function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(\`Missing required environment variable: \${key}\`)
  }
  return value
}

export const config = {
  // Server — bind to internal network only
  port: parseInt(process.env['PORT'] ?? '4000', 10),
  host: process.env['HOST'] ?? '127.0.0.1',

  // Auth
  bearerToken: requireEnv('BEARER_TOKEN'),
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),

  // CORS — strict internal origins only
  allowedOrigins: (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:3000').split(','),

  // Memory encryption
  memoryEncryptionKey: requireEnv('MEMORY_ENCRYPTION_KEY'),

  // Token budget — strict limits for cost control
  maxTokensPerRequest: parseInt(process.env['MAX_TOKENS_PER_REQUEST'] ?? '4096', 10),
  maxTokensPerDay: parseInt(process.env['MAX_TOKENS_PER_DAY'] ?? '500000', 10),

  // Audit
  auditLogPath: process.env['AUDIT_LOG_PATH'] ?? './logs/audit.jsonl',

  // Input sanitization
  maxInputLength: parseInt(process.env['MAX_INPUT_LENGTH'] ?? '10000', 10),
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
          server: { port: 4000, auth: 'bearer', host: '127.0.0.1' },
          security: {
            cors: 'strict',
            inputSanitization: true,
            auditLogging: true,
            memoryEncryption: true,
          },
          memory: {
            encryption: true,
          },
          tokenBudget: {
            maxPerRequest: 4096,
            maxPerDay: 500000,
          },
        },
        null,
        2,
      ),
    },
    {
      path: '.env.example',
      templateContent: `# {{projectName}} — secure internal assistant environment

# Server (bind to internal network)
PORT=4000
HOST=127.0.0.1

# Auth — bearer token for all requests
BEARER_TOKEN=your-secure-bearer-token

# LLM
ANTHROPIC_API_KEY=your-api-key-here

# CORS — comma-separated internal origins
ALLOWED_ORIGINS=http://localhost:3000,http://internal.corp.example.com

# Memory encryption (32-byte hex key)
MEMORY_ENCRYPTION_KEY=your-32-byte-hex-encryption-key-here

# Token budgets
MAX_TOKENS_PER_REQUEST=4096
MAX_TOKENS_PER_DAY=500000

# Input limits
MAX_INPUT_LENGTH=10000

# Audit logging
AUDIT_LOG_PATH=./logs/audit.jsonl
`,
    },
    {
      path: 'README.md',
      templateContent: `# {{projectName}}

Secure internal assistant built with DzupAgent for corporate use.

## Security Features

- Bearer token authentication on all endpoints
- No public-facing endpoints (binds to 127.0.0.1 by default)
- Strict CORS lockdown to allowed internal origins
- Input sanitization with configurable length limits
- Memory encryption at rest
- Audit logging to JSONL for compliance
- Strict token budgets (per-request and daily)

## Quick Start

\`\`\`bash
# Copy environment file and configure secrets
cp .env.example .env

# Install dependencies
npm install

# Run in development mode
npm run dev
\`\`\`

## Configuration

All sensitive values are loaded from environment variables.
See \`.env.example\` for the full list.

## Audit Logs

Audit logs are written to \`AUDIT_LOG_PATH\` (default: \`./logs/audit.jsonl\`).
Each line is a JSON object with timestamp, user, action, and metadata.
`,
    },
    {
      path: '.gitignore',
      templateContent: `node_modules/
dist/
.env
*.tsbuildinfo
logs/
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
