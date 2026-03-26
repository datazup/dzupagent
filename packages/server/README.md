# @forgeagent/server

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Beta | **Coverage:** 66% | **Exports:** 201

| Metric | Value |
|--------|-------|
| Source Files | 84 |
| Lines of Code | 21,421 |
| Test Files | 39 |
| Internal Dependencies | `@forgeagent/agent`, `@forgeagent/core`, `@forgeagent/memory-ipc` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @forgeagent/server
```
<!-- AUTO-GENERATED-END -->

Optional Hono-based HTTP/WebSocket runtime for ForgeAgent.

It provides REST APIs for agents/runs, realtime event streaming, optional memory routes, auth and rate limiting middleware, queue worker integration, and deployment/runtime helpers.

## Main Features

- Hono app factory via `createForgeApp`
- REST APIs: health, agents, runs, approvals, event stream
- Event fan-out bridge for SSE/WS clients
- Optional memory IPC routes (`/api/memory`, `/api/memory-browse`)
- Optional static playground mount at `/playground`
- API key auth middleware and token-bucket rate limiting
- In-memory queue worker integration with pluggable run executor
- RBAC, tenant scope middleware, and identity/capability helpers
- Platform adapters for Lambda, Vercel, and Cloudflare

## Installation

```bash
yarn add @forgeagent/server
# or
npm install @forgeagent/server
```

## How To Use

### 1. Create a server app

```ts
import { createForgeApp } from '@forgeagent/server'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@forgeagent/core'

const app = createForgeApp({
  runStore: new InMemoryRunStore(),
  agentStore: new InMemoryAgentStore(),
  eventBus: createEventBus(),
  modelRegistry: new ModelRegistry(),
  corsOrigins: ['http://localhost:5173'],
})

export default app
```

### 2. Enable auth/rate limit (recommended)

```ts
const app = createForgeApp({
  ...baseConfig,
  auth: { apiKeys: [process.env.FORGE_API_KEY!] },
  rateLimit: { capacity: 60, refillRate: 1 },
})
```

### 3. Mount built playground (optional)

```ts
import { resolve } from 'node:path'

const app = createForgeApp({
  ...baseConfig,
  playground: {
    distDir: resolve(process.cwd(), 'packages/forgeagent-playground/dist'),
  },
})
```

When configured, playground assets are served at `/playground`.

### 4. Add memory routes (optional)

```ts
const app = createForgeApp({
  ...baseConfig,
  memoryService,
})
```

This enables:

- `GET/POST /api/memory/*`
- `GET /api/memory-browse/*`

## Default Routes

- `GET /api/health`
- `GET /api/health/ready`
- `GET|POST|PATCH|DELETE /api/agents/*`
- `GET|POST /api/runs/*`
- `POST /api/runs/:id/approve|reject|cancel`
- `GET /api/events/stream`

Conditional routes:

- `/api/memory/*` and `/api/memory-browse/*` when `memoryService` is configured
- `/playground/*` when `playground.distDir` is configured

## Common Scripts (package source)

```bash
npm run build
npm run typecheck
npm run test
```

## License

MIT
