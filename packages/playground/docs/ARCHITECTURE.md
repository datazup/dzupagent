# @dzupagent/playground Architecture

## Scope
This document describes the **current local reality** for `packages/playground` in this checkout.

- Target path exists only as this documentation file: `packages/playground/docs/ARCHITECTURE.md`.
- The implementation scope directory requested for review, `packages/playground`, is **not present** as a workspace package.
- There is no local `packages/playground/src`, `packages/playground/package.json`, or `packages/playground/README.md` to inspect.

The playground surface is currently split across:

- `packages/server/src/routes/playground.ts` for static SPA asset serving at `/playground/*`.
- `packages/server/src/composition/optional-routes.ts` for conditional mount wiring.
- `packages/agent/src/playground/*` for framework-internal playground/team coordination runtime types and helpers.

## Responsibilities
Because `packages/playground` is absent, it has no active package-level runtime responsibility.

Current responsibilities that historically mapped to “playground” are handled by other packages:

- `@dzupagent/server`:
  - Optional static route mount (`/playground`) via `createPlaygroundRoutes`.
  - File serving, MIME selection, SPA fallback to `index.html`, and path traversal guardrails.
- `@dzupagent/agent`:
  - `AgentPlayground`, `SharedWorkspace`, `TeamCoordinator`, and related playground/team types under `src/playground`.
  - Internal/runtime coordination primitives, not product UI hosting.

## Structure
There is no package structure under `packages/playground` in this checkout.

Observed adjacent structure that implements playground-related behavior:

- `packages/server/src/routes/playground.ts`
- `packages/server/src/composition/optional-routes.ts`
- `packages/server/src/index.ts` (exports `createPlaygroundRoutes` and `PlaygroundRouteConfig`)
- `packages/server/src/__tests__/playground-routes.test.ts`
- `packages/server/src/__tests__/playground-routes-branches.test.ts`
- `packages/agent/src/playground/index.ts`
- `packages/agent/src/playground/playground.ts`
- `packages/agent/src/playground/shared-workspace.ts`
- `packages/agent/src/playground/team-coordinator.ts`
- `packages/agent/src/playground/types.ts`
- `packages/agent/src/playground/ui/*`

## Runtime and Control Flow
Current control flow for playground hosting is in server composition:

1. Host config provides `runtimeConfig.playground` with `distDir`.
2. `mountOptionalRoutes(...)` in `packages/server/src/composition/optional-routes.ts` checks `runtimeConfig.playground`.
3. When configured, server mounts `app.route('/playground', createPlaygroundRoutes(runtimeConfig.playground))`.
4. `createPlaygroundRoutes(...)` in `packages/server/src/routes/playground.ts` serves:
   - `/assets/:path` with immutable cache headers.
   - `/:path{.*}` as static asset or SPA fallback to `index.html`.
5. If `index.html` is missing, route returns 404 with build guidance.

For framework runtime playground coordination:

1. Consumers import from `@dzupagent/agent` (`AgentPlayground`, `SharedWorkspace`, `TeamCoordinator`, playground types).
2. Team and spawned-agent orchestration occurs in-memory through `packages/agent/src/playground/*` abstractions.

## Key APIs and Types
No APIs are currently exported from a `packages/playground` package in this checkout.

Key active APIs that replaced/superseded package-level playground behavior:

- Server hosting APIs:
  - `createPlaygroundRoutes(config: PlaygroundRouteConfig)`
  - `PlaygroundRouteConfig` with `distDir: string`
- Agent playground runtime exports (from `packages/agent/src/index.ts`):
  - `AgentPlayground`
  - `PlaygroundConfig`
  - `SharedWorkspace`
  - `TeamCoordinator`
  - Playground/team event and spawn types from `packages/agent/src/playground/types.ts`

## Dependencies
`packages/playground` has no local dependency graph because the package is absent.

Relevant dependency/runtime surfaces in active implementations:

- Server playground route implementation depends on:
  - `hono`
  - Node `fs/promises` (`readFile`, `stat`)
  - Node `path` (`resolve`, `extname`, `sep`)
- Agent playground runtime depends on core agent/orchestration internals under `packages/agent`.

## Integration Points
Current integration points tied to “playground” behavior:

- Server optional route composition (`mountOptionalRoutes`) mounts `/playground` when configured.
- Server README and root README still reference running/building `@dzupagent/playground`.
- Server architecture docs currently contain references to old `packages/playground/src/*` paths.
- Agent package exports playground runtime primitives via its public index.

## Testing and Observability
There are no package-local tests under `packages/playground` because the package is absent.

Active automated coverage for playground-related behavior exists in:

- `packages/server/src/__tests__/playground-routes.test.ts`
- `packages/server/src/__tests__/playground-routes-branches.test.ts`
- `packages/agent/src/__tests__/playground-ui-utils.test.ts`
- Additional agent tests importing playground types in orchestration/team test suites.

Observability and operational behavior for hosted UI route is inherited from server middleware/composition (health, metrics, error handling) rather than a dedicated playground package.

## Risks and TODOs
- Documentation drift: root README still suggests `yarn workspace @dzupagent/playground dev` although no such workspace package exists in this checkout.
- Documentation drift: server docs and README still mention legacy package paths (`packages/playground/...` and `packages/dzupagent-playground/dist`).
- Architecture drift: references to the removed package can mislead maintenance tasks and automation expecting `packages/playground/src`.
- TODO: refresh root/server docs to reflect current source-of-truth locations (`packages/server/src/routes/playground.ts` and `packages/agent/src/playground/*`).
- TODO: if a dedicated UI package is reintroduced, add a real `package.json`, `README.md`, and implementation tree under `packages/playground` and replace this decommission note.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten against live checkout; documented that `packages/playground` package is absent and mapped active playground behavior to server and agent packages.
