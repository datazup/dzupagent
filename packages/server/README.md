# @forgeagent/server

Optional HTTP/WebSocket runtime for ForgeAgent. Provides a Hono REST API, run/agent persistence with Drizzle + PostgreSQL, RBAC, approval management, SSE/WebSocket streaming, API key authentication, rate limiting, CLI tools, deployment helpers, and platform adapters (Lambda, Vercel, Cloudflare).

## Installation

```bash
yarn add @forgeagent/server
# or
npm install @forgeagent/server
```

## Quick Start

```ts
import { createForgeApp } from '@forgeagent/server'
import { ForgeAgent } from '@forgeagent/agent'

const agent = new ForgeAgent({ name: 'my-agent', model, tools })

const app = createForgeApp({
  agents: [agent],
  database: process.env.DATABASE_URL,
  auth: { apiKeys: [process.env.API_KEY!] },
})

// Start the server
export default app // Hono app, works with any runtime
```

## API Reference

### App

- `createForgeApp(config)` -- create a fully configured Hono application

**Types:** `ForgeServerConfig`

### Routes

- `createRunRoutes()` -- CRUD for agent runs (start, get, list, cancel)
- `createAgentRoutes()` -- agent definition management
- `createApprovalRoutes()` -- human-in-the-loop approval endpoints
- `createHealthRoutes()` -- health and readiness checks
- `createMemoryRoutes(config)` -- memory CRUD via Arrow IPC
- `createMemoryBrowseRoutes(config)` -- memory browsing UI endpoints
- `createPlaygroundRoutes(config)` -- playground integration endpoints

**Types:** `MemoryRouteConfig`, `MemoryBrowseRouteConfig`, `PlaygroundRouteConfig`

### Persistence

- `PostgresRunStore` -- run persistence with Drizzle ORM
- `PostgresAgentStore` -- agent definition persistence
- `forgeAgents` / `forgeRuns` / `forgeRunLogs` -- Drizzle schema definitions

### Middleware

- `authMiddleware(config)` -- API key authentication
- `rateLimiterMiddleware(config)` -- token bucket rate limiting
- `identityMiddleware(config)` -- ForgeAgent identity resolution
- `capabilityGuard(capability)` -- capability-based access control
- `rbacMiddleware(config)` / `rbacGuard(permission)` -- role-based access control
- `tenantScopeMiddleware(config)` -- multi-tenant scope isolation

**Types:** `AuthConfig`, `RateLimiterConfig`, `IdentityMiddlewareConfig`, `ForgeRole`, `ForgePermission`, `RBACConfig`, `TenantScopeConfig`

### Queue

- `InMemoryRunQueue` -- background job queue for agent runs

**Types:** `RunQueue`, `RunJob`, `RunQueueConfig`, `QueueStats`

### Lifecycle

- `GracefulShutdown` -- graceful shutdown with drain timeout

**Types:** `ShutdownConfig`, `ShutdownState`

### WebSocket

- `EventBridge` -- bridge ForgeAgent events to WebSocket clients

**Types:** `WSClient`, `ClientFilter`

### Notifications

- `Notifier` -- multi-channel notification system
- `WebhookChannel` -- webhook notification delivery
- `ConsoleChannel` -- console output for development

**Types:** `Notification`, `NotificationChannel`, `NotifierConfig`, `NotificationTier`

### A2A Protocol

- `buildAgentCard(config)` -- generate an Agent Card for discovery
- `createA2ARoutes(config)` -- Agent-to-Agent protocol routes
- `InMemoryA2ATaskStore` -- in-memory A2A task storage

**Types:** `AgentCard`, `AgentCapability`, `A2ATask`, `A2ATaskState`

### Triggers

- `TriggerManager` -- manage cron, webhook, and chain triggers for agent runs

**Types:** `TriggerType`, `CronTriggerConfig`, `WebhookTriggerConfig`, `ChainTriggerConfig`

### Platform Adapters

- `toLambdaHandler(app)` -- adapt Hono app for AWS Lambda
- `toVercelHandler(app)` -- adapt Hono app for Vercel Functions
- `toCloudflareHandler(app)` -- adapt Hono app for Cloudflare Workers

### CLI

- `createDevCommand(config)` -- start a dev server with hot reload
- `configValidate()` / `configShow()` -- validate and display configuration
- `memoryBrowse(options)` / `memorySearch(options)` -- browse and search memories
- `listPlugins()` / `addPlugin()` / `removePlugin()` -- plugin management
- `searchMarketplace(query)` -- search plugin marketplace

**Types:** `DevCommandConfig`, `MemoryBrowseOptions`, `PluginInfo`, `MarketplacePlugin`

### Runtime

- `InMemoryQuotaManager` -- resource quota enforcement
- `QuotaExceededError` -- thrown when quotas are exceeded

**Types:** `ResourceDimensions`, `ResourceQuota`, `ResourceReservation`, `QuotaCheckResult`

### Deploy

- `generateDockerfile(config)` / `generateDockerCompose(config)` / `generateDockerignore()` -- Docker deployment helpers
- `checkHealth(url)` -- health check utility

**Types:** `DockerConfig`, `HealthCheckResult`

### Security

- `IncidentResponseEngine` -- automated incident response with playbooks
- `clearIncidentFlags()` / `isAgentKilled()` / `isToolDisabled()` / `isNamespaceQuarantined()` -- incident state queries

**Types:** `IncidentAction`, `IncidentTrigger`, `IncidentPlaybook`, `IncidentRecord`, `IncidentResponseConfig`

### Documentation Generation

- `DocGenerator` -- generate Markdown documentation for agents, tools, and pipelines
- `renderAgentDoc(input)` / `renderToolDoc(input)` / `renderPipelineDoc(input)` -- render specific doc types

**Types:** `DocGeneratorConfig`, `AgentDocInput`, `ToolDocInput`, `PipelineDocInput`

### Version

- `FORGEAGENT_SERVER_VERSION: string` -- `'0.1.0'`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@forgeagent/core` | `0.1.0` | Core infrastructure |
| `@forgeagent/memory-ipc` | `0.1.0` | Arrow-based memory transport |
| `drizzle-orm` | `^0.40.1` | Database ORM |
| `hono` | `^4.12.9` | HTTP framework |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `postgres` | `^3.4.0` | PostgreSQL driver |

## License

MIT
