# @dzupagent/server

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Beta | **Coverage:** 66% | **Exports:** 201

| Metric | Value |
|--------|-------|
| Source Files | 84 |
| Lines of Code | 21,421 |
| Test Files | 39 |
| Internal Dependencies | `@dzupagent/agent`, `@dzupagent/core`, `@dzupagent/memory-ipc` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @dzupagent/server
```
<!-- AUTO-GENERATED-END -->

Optional Hono-based HTTP/WebSocket runtime for DzupAgent.

It provides REST APIs for agents/runs, realtime event streaming, optional memory routes, auth and rate limiting middleware, queue worker integration, and deployment/runtime helpers.

## Product Boundary

`@dzupagent/server` is a framework/runtime host, not the forward path for new
application product-control-plane routes. Existing route families are classified
as:

- Generic framework primitives: runs, agents, approvals, health, events,
  memory, registry, API keys, capabilities, metrics, and route support helpers.
- Compatibility or maintenance surfaces: playground static hosting, OpenAI
  compatibility, A2A, eval/benchmark/deploy/learning, prompts/personas/presets,
  marketplace, mailbox/clusters, triggers/schedules, and reflections.
- Route-plugin host seams: MCP, skills, workflow/compile, and host-supplied
  `routePlugins`.

New product concepts such as workspaces, projects, tasks/subtasks, operator UX,
tenant-specific dashboards, or Codev-owned controls should live in the
consuming app. Compose them beside `createForgeApp` in the app's Hono server or
mount them through `routePlugins`:

```ts
const app = createForgeApp({
  ...baseConfig,
  routePlugins: [
    {
      prefix: '/api/codev/projects',
      createRoutes: () => codevProjectRoutes,
    },
  ],
})
```

Migration note: if an existing app-specific route is currently implemented in
`packages/server`, keep it compatible until it has an app-owned replacement,
then deprecate the server route separately. New files under
`packages/server/src/routes/**` must be declared in
`config/architecture-boundaries.json` with a maintenance/compatibility,
framework-primitive, route-plugin-host-seam, or internal-support rationale;
`yarn check:domain-boundaries` fails otherwise.

## Server Config And Route Families

`ForgeServerConfig` remains the compatibility aggregate accepted by
`createForgeApp`, but its route-facing options are split into feature-family
contracts:

- `ForgeMemoryRouteFamilyConfig`
- `ForgeCompatibilityRouteFamilyConfig`
- `ForgeEvaluationRouteFamilyConfig`
- `ForgeAdapterRouteFamilyConfig`
- `ForgeAutomationRouteFamilyConfig`
- `ForgeControlPlaneRouteFamilyConfig`

Existing fields such as `memoryHealth`, `evals`, `playground`, `a2a`,
`promptStore`, and `mailDelivery` still work on `ForgeServerConfig`. Internally,
the server adapts those legacy fields into route-family plugins before mounting
them. New product-specific feature families should define their own app-owned
config and pass a `ServerRoutePlugin` through `routePlugins` instead of adding
new optional fields to `ForgeServerConfig`.

```ts
import type { ServerRoutePlugin } from '@dzupagent/server'

interface CodevProjectRoutesConfig {
  projectStore: ProjectStore
  workspacePolicy: WorkspacePolicy
}

function createCodevProjectPlugin(config: CodevProjectRoutesConfig): ServerRoutePlugin {
  return {
    family: 'codev-projects',
    prefix: '/api/codev/projects',
    createRoutes: () => createCodevProjectRoutes(config),
  }
}
```

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
yarn add @dzupagent/server
# or
npm install @dzupagent/server
```

## How To Use

### 1. Create a server app

```ts
import { createForgeApp } from '@dzupagent/server'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

const app = createForgeApp({
  runStore: new InMemoryRunStore(),
  agentStore: new InMemoryAgentStore(),
  eventBus: createEventBus(),
  modelRegistry: new ModelRegistry(),
  // Local development or legacy compatibility only. Use api-key auth for production.
  auth: { mode: 'none' },
  corsOrigins: ['http://localhost:5173'],
})

export default app
```

Production server creation requires an explicit framework API auth mode for
`/api/*` routes. Omitted `auth` still works for non-production compatibility,
but it emits a startup warning; with `NODE_ENV=production`, `createForgeApp`
throws before returning an unauthenticated API host.

Browser CORS exposure is disabled by default. Set `corsOrigins` to an explicit
origin or origin list for browser clients:

```ts
const app = createForgeApp({
  ...baseConfig,
  auth: { mode: 'api-key', validateKey },
  corsOrigins: ['https://app.example.com'],
})
```

Wildcard CORS is a compatibility mode, not a production default. In production,
`corsOrigins: '*'` throws unless `allowWildcardCors: true` is also set. The
opt-in also enables wildcard CORS when `corsOrigins` is omitted:

```ts
const app = createForgeApp({
  ...baseConfig,
  auth: { mode: 'api-key', validateKey },
  allowWildcardCors: true,
})
```

Do not use wildcard CORS for credentialed browser-token deployments. Migration
note: hosts that relied on the old implicit `*` default must now either add a
specific `corsOrigins` allow-list or intentionally set `allowWildcardCors`.

### 2. Enable auth/rate limit (recommended)

```ts
const app = createForgeApp({
  ...baseConfig,
  auth: {
    mode: 'api-key',
    validateKey: async (key) => {
      return key === process.env.DZIP_API_KEY
        ? { id: 'admin-key', role: 'admin' }
        : null
    },
  },
  rateLimit: { capacity: 60, refillRate: 1 },
})
```

When auth is enabled, global RBAC is enabled unless `rbac: false` is set.
RBAC denies unknown `/api/*` management route groups by default. Built-in
high-risk groups such as `/api/keys`, `/api/registry`, `/api/triggers`,
`/api/schedules`, `/api/deploy`, `/api/evals`, `/api/benchmarks`,
`/api/prompts`, `/api/personas`, `/api/marketplace`, `/api/mailbox`,
`/api/clusters`, and `/api/mcp` require the `admin` role. Health routes under
`/api/health` remain public to auth/RBAC for readiness checks.

For local development or legacy hosts that intentionally expose unauthenticated
framework APIs, configure the opt-out explicitly:

```ts
const app = createForgeApp({
  ...baseConfig,
  auth: { mode: 'none' },
})
```

This mode emits a startup warning and should not be used for production. The
recommended production shape is `auth: { mode: 'api-key', validateKey }` backed
by a durable API-key store, with RBAC roles such as `admin`, `operator`, and
`viewer` assigned per key. If `apiKeyStore` is supplied with `mode: 'api-key'`,
`createForgeApp` wires its `validate()` method automatically when
`validateKey` is not provided.

Hosts that mount custom route plugins under `/api/*` should add an explicit
RBAC route policy and matching role permissions instead of relying on
pass-through behavior:

```ts
const app = createForgeApp({
  ...baseConfig,
  auth,
  rbac: {
    extractRole: (c) => {
      const apiKey = c.get('apiKey') as { role?: string } | undefined
      return apiKey?.role === 'admin' ? 'admin' : 'operator'
    },
    routePermissions: {
      '/api/custom-plugin': { resource: 'settings', action: 'read' },
    },
    customPermissions: {
      operator: [{ resource: 'settings', action: 'read' }],
    },
  },
  routePlugins: [
    {
      prefix: '/api/custom-plugin',
      createRoutes: () => customPluginRoutes,
    },
  ],
})
```

### 3. Protect Prometheus metrics

`/metrics` is disabled by default, even when `metrics` is a
`PrometheusMetricsCollector`. Enable it with a framework-level access policy so
the application remains protected if ingress rules drift:

```ts
import { PrometheusMetricsCollector, createForgeApp } from '@dzupagent/server'

const app = createForgeApp({
  ...baseConfig,
  metrics: new PrometheusMetricsCollector(),
  prometheusMetrics: {
    access: {
      mode: 'token',
      token: process.env.PROMETHEUS_METRICS_TOKEN!,
    },
  },
})
```

Prometheus should scrape with `Authorization: Bearer <token>`. Hosts can also
use `mode: 'middleware'` to enforce an injected IP, host, listener, or platform
guard before rendering metrics.

Public unauthenticated scraping is available only through an explicit unsafe
development opt-in:

```ts
const app = createForgeApp({
  ...baseConfig,
  metrics: new PrometheusMetricsCollector(),
  prometheusMetrics: {
    access: { mode: 'unsafe-public', reason: 'local docker compose only' },
  },
})
```

Ingress allow-lists, private listeners, and network policies are useful defense
in depth, but they should not be the primary protection for `/metrics`.

### 4. Mount built playground (optional)

```ts
import { resolve } from 'node:path'

const app = createForgeApp({
  ...baseConfig,
  playground: {
    distDir: resolve(process.cwd(), 'packages/dzupagent-playground/dist'),
  },
})
```

When configured, playground assets are served at `/playground`.

### 5. Configure HTTP connector profiles

The built-in `http_request` tool uses server-side HTTP connector profiles. Run
metadata no longer supplies `metadata.httpBaseUrl` or `metadata.httpHeaders` by
default because run metadata is commonly persisted and may be user-controlled.

```ts
const app = createForgeApp({
  ...baseConfig,
  httpConnectorProfiles: {
    default: {
      baseUrl: 'https://api.example.com',
      headers: { Authorization: `Bearer ${process.env.EXAMPLE_API_TOKEN}` },
      allowedMethods: ['GET', 'POST'],
    },
    internalStatus: {
      baseUrl: 'http://127.0.0.1:8080/status',
      allowedHosts: ['127.0.0.1:8080'],
    },
  },
  defaultHttpConnectorProfile: 'default',
})
```

Public HTTP and HTTPS origins are accepted by default. Private, loopback, and
link-local origins must be explicitly listed in the selected profile's
`allowedHosts`. Legacy metadata-driven HTTP connector configuration is available
only through `allowUnsafeMetadataHttpConnector: true`; do not enable it for
untrusted run metadata.

### 6. Configure GitHub and Slack connector profiles

GitHub and Slack connector tokens are resolved from server-side profiles or
explicit environment-backed defaults. Run metadata may select a profile by name
with `metadata.githubProfile` or `metadata.slackProfile`, but raw
`metadata.githubToken` and `metadata.slackToken` are ignored and stripped from
persisted run metadata.

```ts
const app = createForgeApp({
  ...baseConfig,
  githubConnectorProfiles: {
    default: { envVar: 'GITHUB_TOKEN' },
    release: { envVar: 'GITHUB_RELEASE_TOKEN' },
  },
  slackConnectorProfiles: {
    default: { envVar: 'SLACK_BOT_TOKEN' },
  },
})
```

For MCP, inline `env` and `headers` remain supported only on server-owned MCP
registrations, where API responses redact their values. Metadata-defined MCP
servers may not carry `env` or `headers`; use `/api/mcp/servers` definitions
with `envRef`/`headerRef` or server-managed profiles instead. Migration note:
move any run payload fields such as `githubToken`, `slackToken`,
`httpHeaders`, or `mcpServers[].env` into server configuration or a secret
manager before relying on persisted runs.

### 7. Configure Git workspace profiles

Built-in Git tools run inside server-selected workspace roots. Run metadata no
longer controls the Git cwd by default; use `metadata.gitWorkspace` only to pick
a named server-side profile.

```ts
const app = createForgeApp({
  ...baseConfig,
  gitWorkspaceProfiles: {
    default: {
      root: '/srv/dzupagent/workspaces/main-repo',
    },
    releaseRepo: {
      root: '/srv/dzupagent/workspaces/release-repo',
      allowMutatingTools: true,
    },
  },
  defaultGitWorkspaceProfile: 'default',
})
```

Read-only tools such as `git_status`, `git_diff`, and `git_log` remain
available for configured workspaces. Mutating tools such as `git_commit` and
branch create/switch return a policy denial unless the selected profile sets
`allowMutatingTools: true`, which should be wired to the host's approval or
governance flow.

Legacy `metadata.cwd` compatibility is available only with
`allowUnsafeMetadataGitCwd: true`, and the requested cwd must still resolve
inside the selected workspace root. Do not enable it for untrusted run metadata.

### 8. Add memory routes (optional)

```ts
const app = createForgeApp({
  ...baseConfig,
  memoryService,
})
```

This enables:

- `GET/POST /api/memory/*`
- `GET /api/memory-browse/*`

### 9. Attach WebSocket upgrades safely

`createNodeWsUpgradeHandler` and `createWsServer().attach()` reject upgrades by
default unless callers provide an explicit request guard, a scope resolver, or a
path guard through `createWsServer({ server: { path: '/ws' } })`.

The legacy unauthenticated allow-all behavior is still available for local
development and tests with `allowUnsafeUnauthenticated: true`. Do not enable
that option for production helpers.

## Default Routes

- `GET /api/health`
- `GET /api/health/ready`
- `GET|POST|PATCH|DELETE /api/agent-definitions/*`
- `GET|POST|PATCH|DELETE /api/agents/*` (deprecated compatibility alias)
- `GET|POST /api/runs/*`
- `POST /api/runs/:id/approve|reject|cancel`
- `GET /api/events/stream`

Conditional routes:

- `/api/registry/*` when `registry` is configured
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
