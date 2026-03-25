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
- `createWsControlHandler` -- handle `subscribe` / `unsubscribe` control messages
- `createScopedAuthorizeFilter` -- build tenant/scope-aware WS filter authorization
- `WSClientScopeRegistry` -- store per-connection scope/claims context
- `createScopedWsControlHandler` -- compose control handler + scoped authorization
- `WSSessionManager` -- lifecycle helper for WS open/message/close integration
- `attachNodeWsSession` -- bind Node `ws` socket events to `WSSessionManager`
- `createNodeWsUpgradeHandler` -- build a safe Node HTTP upgrade handler
- `createPathUpgradeGuard` -- best-practice path filter for upgrade requests

**Types:** `WSClient`, `ClientFilter`, `WSControlHandlerOptions`, `WSClientScope`, `ScopedWsControlHandlerOptions`, `WSSessionManagerOptions`, `NodeWSLike`, `NodeWsUpgradeHandlerOptions`

Example integration (host WS runtime pseudo-code):

```ts
import {
  EventBridge,
  WSClientScopeRegistry,
  createScopedWsControlHandler,
} from '@forgeagent/server'

const bridge = new EventBridge(eventBus)
const scopeRegistry = new WSClientScopeRegistry()

// on websocket connection:
bridge.addClient(ws, {})
scopeRegistry.set(ws, {
  tenantId: 't1',
  runIds: ['run-1', 'run-2'],
  agentIds: ['agent-a'],
  eventTypes: ['agent:started', 'agent:completed', 'agent:failed'],
})

const onControl = createScopedWsControlHandler(bridge, ws, scopeRegistry, {
  requireScopedSubscription: true,
  unsubscribeFilter: {}, // or a tenant-safe baseline filter
})

ws.on('message', (raw) => void onControl(String(raw)))
ws.on('close', () => {
  scopeRegistry.delete(ws)
  bridge.removeClient(ws)
})
```

Alternative with session manager:

```ts
import { EventBridge, WSClientScopeRegistry, WSSessionManager } from '@forgeagent/server'

const bridge = new EventBridge(eventBus)
const scopeRegistry = new WSClientScopeRegistry()
const wsManager = new WSSessionManager(bridge, scopeRegistry, {
  requireScopedSubscription: true,
  resolveScope: (ws) => sessionMap.get(ws) ?? null,
})

// on websocket connection:
await wsManager.attach(ws)
ws.on('message', (raw) => void wsManager.handleMessage(ws, String(raw)))
ws.on('close', () => wsManager.detach(ws))
```

Node `ws` adapter shortcut:

```ts
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import {
  EventBridge,
  WSClientScopeRegistry,
  WSSessionManager,
  attachNodeWsSession,
} from '@forgeagent/server'

const server = createServer()
const wss = new WebSocketServer({ noServer: true })

const bridge = new EventBridge(eventBus)
const scopeRegistry = new WSClientScopeRegistry()
const wsManager = new WSSessionManager(bridge, scopeRegistry, {
  requireScopedSubscription: true,
})

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const scope = resolveScopeFromRequest(req) // your tenant/run/agent claims
    void attachNodeWsSession({ manager: wsManager, socket: ws, scope })
  })
})
```

Best-practice Node upgrade handler:

```ts
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import {
  EventBridge,
  WSClientScopeRegistry,
  WSSessionManager,
  createNodeWsUpgradeHandler,
  createPathUpgradeGuard,
} from '@forgeagent/server'

const server = createServer()
const wss = new WebSocketServer({ noServer: true })

const bridge = new EventBridge(eventBus)
const scopeRegistry = new WSClientScopeRegistry()
const wsManager = new WSSessionManager(bridge, scopeRegistry, {
  requireScopedSubscription: true,
})

const upgradeHandler = createNodeWsUpgradeHandler({
  wss,
  manager: wsManager,
  shouldHandleRequest: createPathUpgradeGuard('/ws'),
  resolveScopeFromRequest: (req) => resolveScopeFromRequest(req),
  onRejected: ({ reason }) => console.warn('WS rejected:', reason),
  onAttachError: ({ error }) => console.error('WS attach failed', error),
})

server.on('upgrade', upgradeHandler)
```

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
