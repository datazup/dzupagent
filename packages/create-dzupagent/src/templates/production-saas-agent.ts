import type { TemplateManifest } from '../types.js'

export const productionSaasAgentTemplate: TemplateManifest = {
  id: 'production-saas-agent',
  name: 'Production SaaS Agent',
  description: 'Enterprise-grade agent with security, observability, persistence, and Docker.',
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
            dev: 'tsx watch src/index.ts',
            typecheck: 'tsc --noEmit',
            'db:push': 'drizzle-kit push',
            'db:generate': 'drizzle-kit generate',
            lint: 'eslint src/',
            test: 'vitest run',
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
      templateContent: `// {{projectName}} — production SaaS agent
import { createForgeApp } from '@dzupagent/server'
import { config } from './config.js'

const app = createForgeApp({
  auth: { mode: 'api-key' },
  cors: {
    origin: config.corsOrigins,
    credentials: true,
  },
  queue: {
    redis: { url: config.redisUrl },
  },
  database: {
    url: config.databaseUrl,
  },
  otel: {
    serviceName: config.serviceName,
    endpoint: config.otelEndpoint,
  },
})

// Graceful shutdown
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
for (const signal of signals) {
  process.on(signal, () => {
    console.log(\`Received \${signal}, shutting down gracefully...\`)
    process.exit(0)
  })
}

// Health check endpoint is built into createForgeApp
export default { port: config.port, fetch: app.fetch }
console.log(\`{{projectName}} running on port \${config.port}\`)
`,
    },
    {
      path: 'src/config.ts',
      templateContent: `// {{projectName}} — production configuration
function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(\`Missing required environment variable: \${key}\`)
  }
  return value
}

export const config = {
  // Server
  port: parseInt(process.env['PORT'] ?? '4000', 10),
  serviceName: process.env['SERVICE_NAME'] ?? '{{projectName}}',
  corsOrigins: (process.env['CORS_ORIGINS'] ?? 'http://localhost:3000').split(','),

  // Database
  databaseUrl: requireEnv('DATABASE_URL'),

  // Redis
  redisUrl: requireEnv('REDIS_URL'),

  // Auth
  forgeApiKey: requireEnv('DZIP_API_KEY'),

  // LLM
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),

  // Observability
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318',

  // Policy
  maxTokensPerRequest: parseInt(process.env['MAX_TOKENS_PER_REQUEST'] ?? '8192', 10),
  rateLimitRpm: parseInt(process.env['RATE_LIMIT_RPM'] ?? '60', 10),
} as const
`,
    },
    {
      path: 'Dockerfile',
      templateContent: `FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .
RUN yarn install --frozen-lockfile --production
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1
USER appuser
EXPOSE 4000
CMD ["node", "dist/index.js"]
`,
    },
    {
      path: 'docker-compose.yml',
      templateContent: `version: "3.9"
services:
  app:
    build: .
    ports:
      - "\${PORT:-4000}:4000"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: {{projectName}}
      POSTGRES_USER: forge
      POSTGRES_PASSWORD: forge_secret
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U forge"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    ports:
      - "4317:4317"
      - "4318:4318"
    volumes:
      - ./otel-config.yml:/etc/otelcol-contrib/config.yaml

volumes:
  pgdata:
`,
    },
    {
      path: 'dzupagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.2.0',
          server: { port: 4000, auth: 'api-key' },
          database: { provider: 'postgres' },
          queue: { provider: 'redis' },
          observability: { otel: true },
          security: { rbac: true, audit: true, policy: true },
        },
        null,
        2,
      ),
    },
    {
      path: '.env.example',
      templateContent: `# {{projectName}} — production environment variables

# Server
PORT=4000
SERVICE_NAME={{projectName}}
CORS_ORIGINS=http://localhost:3000

# Database
DATABASE_URL=postgresql://forge:forge_secret@localhost:5432/{{projectName}}

# Redis
REDIS_URL=redis://localhost:6379

# Auth
DZIP_API_KEY=your-forge-api-key

# LLM
ANTHROPIC_API_KEY=your-api-key-here

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Policy & Rate Limiting
MAX_TOKENS_PER_REQUEST=8192
RATE_LIMIT_RPM=60
`,
    },
    {
      path: 'README.md',
      templateContent: `# {{projectName}}

Production SaaS agent built with DzupAgent.

## Features

- Hono server with API key authentication
- PostgreSQL persistence via Drizzle ORM
- Redis-backed job queue (BullMQ)
- OpenTelemetry tracing and metrics
- Policy engine with RBAC and audit trail
- Health checks and graceful shutdown
- Docker and docker-compose for local and production deployment

## Quick Start

\`\`\`bash
# Copy environment file and edit values
cp .env.example .env

# Start all services with Docker
docker compose up -d

# Or run locally (requires Postgres and Redis running)
npm install
npm run db:push
npm run dev
\`\`\`

## Production Deployment

\`\`\`bash
docker compose -f docker-compose.yml up -d --build
\`\`\`

## Environment Variables

See \`.env.example\` for all required configuration.
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
    '@dzupagent/server': '^0.2.0',
    '@dzupagent/memory': '^0.2.0',
    '@dzupagent/context': '^0.2.0',
    '@dzupagent/otel': '^0.2.0',
    'drizzle-orm': '^0.36.0',
    bullmq: '^5.0.0',
    ioredis: '^5.4.0',
  },
  devDependencies: {
    typescript: '^5.4.0',
    tsup: '^8.0.0',
    tsx: '^4.0.0',
    'drizzle-kit': '^0.28.0',
    vitest: '^2.0.0',
  },
}
