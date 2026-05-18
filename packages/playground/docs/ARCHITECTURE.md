# Playground Architecture (Compatibility Surface)

## Scope
This document covers the current state of `packages/playground` in this checkout.

Observed local state inside `packages/playground`:
- `docs/ARCHITECTURE.md` exists.
- No `src/` directory exists.
- No `package.json` exists.
- No `README.md` exists.

As of this refresh, `packages/playground` is a docs-only compatibility location, not an active Yarn workspace package.

## Responsibilities
`packages/playground` has no runtime responsibility because it has no implementation package.

Playground-related behavior currently lives in other packages:
- `@dzupagent/server`
  - Hosts optional static SPA assets via `createPlaygroundRoutes(...)`.
  - Mounts those routes under `/playground` only when `runtimeConfig.playground` is configured.
  - Applies HTML security headers by default and blocks path traversal.
- `@dzupagent/agent`
  - Provides framework-internal trace UI helpers under `src/observability/trace-ui/*`.
  - Exposes team/shared-workspace orchestration primitives via `src/orchestration/team/*` exports.

Per repo guidance, `packages/server` and `packages/playground` are maintenance/compatibility surfaces, not the forward path for new product UI features.

## Structure
Current structure of `packages/playground`:

```text
packages/playground/
└── docs/
    └── ARCHITECTURE.md
```

Adjacent implementation files that now carry playground-related functionality:
- `packages/server/src/routes/playground.ts`
- `packages/server/src/composition/optional-routes.ts`
- `packages/server/src/composition/types.ts`
- `packages/server/src/extensions.ts`
- `packages/server/src/__tests__/playground-routes.test.ts`
- `packages/server/src/__tests__/playground-routes-branches.test.ts`
- `packages/agent/src/observability/trace-ui/index.ts`
- `packages/agent/src/observability/trace-ui/utils.ts`
- `packages/agent/src/index.ts` (team/shared-workspace exports)
- `packages/agent/src/__tests__/playground-ui-utils.test.ts`

## Runtime and Control Flow
There is no package-local runtime in `packages/playground`.

Runtime flow for hosted playground assets is implemented in `@dzupagent/server`:
1. Host composition supplies `runtimeConfig.playground` (`PlaygroundRouteConfig`).
2. `mountOptionalRoutes(...)` checks that config.
3. If present, it mounts `app.route('/playground', createPlaygroundRoutes(runtimeConfig.playground))`.
4. `createPlaygroundRoutes(...)` serves:
   - `/assets/:path{.+}` as immutable static assets.
   - `/:path{.*}` as direct static asset when extension is non-HTML, otherwise SPA fallback to `index.html`.
5. Missing `index.html` returns a 404 text response with guidance to point `distDir` at built consuming-app assets.

Route-level safeguards in current code:
- Root-constrained path resolution (`resolveWithinRoot`) blocks traversal attempts.
- MIME mapping is explicit; unknown extensions fall back to `application/octet-stream`.
- HTML responses get default hardening headers unless explicitly overridden/disabled.

## Key APIs and Types
There are no APIs exported from `packages/playground`.

Current playground-related public APIs:
- Server
  - `createPlaygroundRoutes(config: PlaygroundRouteConfig)` in `packages/server/src/routes/playground.ts`
  - `PlaygroundRouteConfig`
    - `distDir: string`
    - `securityHeaders?: PlaygroundSecurityHeadersConfig | false`
  - `PlaygroundSecurityHeadersConfig`
    - `xFrameOptions?: string | false`
    - `contentSecurityPolicy?: string | false`
    - `xContentTypeOptions?: string | false`
    - `referrerPolicy?: string | false`
- Host configuration
  - `ForgeCompatibilityRouteFamilyConfig.playground?: PlaygroundRouteConfig` in `packages/server/src/composition/types.ts`
- Agent internal helpers
  - Trace UI utility exports from `packages/agent/src/observability/trace-ui/index.ts`
  - Shared workspace/team runtime exports in `packages/agent/src/index.ts` (`SharedWorkspace`, `TeamRuntime`, related team types)

## Dependencies
`packages/playground` has no dependency graph because no package manifest exists.

Dependencies used by active playground hosting code (`@dzupagent/server` route layer):
- `hono`
- Node `fs/promises` (`readFile`, `stat`)
- Node `path` (`resolve`, `extname`, `sep`)

Dependencies used by agent trace helper surface are owned by `@dzupagent/agent` and replay/observability modules, not by `packages/playground`.

## Integration Points
Current integration points for the compatibility playground surface:
- Server runtime composition (`mountOptionalRoutes`) enables `/playground` only when configured.
- `@dzupagent/server` re-exports `createPlaygroundRoutes` and `PlaygroundRouteConfig` via `src/extensions.ts`.
- CLI dev command exposes a `noPlayground` flag (`packages/server/src/cli/dev-command.ts`) for local server startup behavior.
- Agent trace helper tests (`playground-ui-utils.test.ts`) validate internal trace style/format helpers in `observability/trace-ui`, indicating the previous `src/playground/ui` location has been consolidated.

## Testing and Observability
There are no tests inside `packages/playground` itself.

Active test coverage for playground behavior:
- `packages/server/src/__tests__/playground-routes.test.ts`
  - root/index serving
  - security headers defaults and overrides
  - static asset MIME/cache behavior
  - path traversal blocking
  - SPA fallback behavior
- `packages/server/src/__tests__/playground-routes-branches.test.ts`
  - MIME branch coverage
  - unknown extension fallback
  - missing `index.html` 404 guidance message
- `packages/agent/src/__tests__/playground-ui-utils.test.ts`
  - rendering-independent trace UI utility contracts (tone/style/density helpers)

Observability for `/playground` requests is inherited from server-level middleware and event/metrics infrastructure; there is no package-specific telemetry in `packages/playground`.

## Risks and TODOs
- Documentation drift risk: stale references to `packages/playground/src` or `@dzupagent/playground` commands can reappear in docs or scripts.
- Ownership confusion risk: internal trace helper utilities in `@dzupagent/agent` may be mistaken for a public product UI package.
- TODO: keep server-facing docs aligned with current static-host model (`runtimeConfig.playground.distDir`) and security-header defaults.
- TODO: if a dedicated playground package is intentionally reintroduced, add real package boundaries (`package.json`, `src/`, `README.md`, tests) and replace this compatibility-only architecture note.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: refreshed against live checkout; confirmed `packages/playground` is docs-only and updated integrations to current `server` and `agent/observability` paths.
- 2026-04-29: removed stale onboarding references to a dedicated playground workspace; preserved this document as a decommission/maintenance note.