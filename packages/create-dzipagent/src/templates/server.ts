import type { TemplateManifest } from '../types.js'

export const serverTemplate: TemplateManifest = {
  id: 'server',
  name: 'Server Deployment',
  description: 'Production-ready agent server with Hono API, Postgres, and Docker.',
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
            'db:push': 'drizzle-kit push',
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
      templateContent: `// {{projectName}} — server ForgeAgent project
import { createForgeApp } from '@forgeagent/server'

const app = createForgeApp({
  auth: { mode: 'api-key' },
})

export default { port: 4000, fetch: app.fetch }
console.log('{{projectName}} server running on port 4000')
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
USER appuser
EXPOSE 4000
CMD ["node", "dist/index.js"]
`,
    },
    {
      path: 'forgeagent.config.json',
      templateContent: JSON.stringify(
        {
          name: '{{projectName}}',
          template: '{{template}}',
          version: '0.1.0',
          server: { port: 4000, auth: 'api-key' },
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
FORGE_API_KEY=your-forge-api-key
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
    '@forgeagent/core': '^0.1.0',
    '@forgeagent/agent': '^0.1.0',
    '@forgeagent/server': '^0.1.0',
    'drizzle-orm': '^0.36.0',
  },
  devDependencies: {
    typescript: '^5.4.0',
    tsup: '^8.0.0',
    tsx: '^4.0.0',
    'drizzle-kit': '^0.28.0',
  },
}
