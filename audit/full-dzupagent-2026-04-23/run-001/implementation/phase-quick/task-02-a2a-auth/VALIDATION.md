# Task 02 — Add authentication to A2A routes

## Files changed
- `packages/server/src/app.ts`

## Change summary

### 1. Promoted `effectiveAuth` out of the `/api/*` block

Previously, the API-key-store → validator adaptation lived inside a local
`if (config.auth)` block and was only used when mounting `authMiddleware`
on `/api/*`. The resolved middleware config was not reachable from the
A2A mount below.

The variable has been lifted to a function-scope `let effectiveAuth:
AuthConfig | undefined` so that both `/api/*` and the A2A routes share
the exact same validator, including the implicit `apiKeyStore` wiring.

Before (excerpt):
```ts
if (config.auth) {
  let effectiveAuth = config.auth
  // ...validator wiring
  app.use('/api/*', authMiddleware(effectiveAuth))
}
```

After:
```ts
let effectiveAuth: AuthConfig | undefined
if (config.auth) {
  effectiveAuth = config.auth
  // ...validator wiring (unchanged)
  app.use('/api/*', authMiddleware(effectiveAuth))
}
```

### 2. Protected A2A routes

Inside the `if (runtimeConfig.a2a) { … }` block, before the routes are
mounted, the middleware is now applied to both the JSON-RPC endpoint at
`/a2a` and the REST-style sub-tree at `/a2a/*`:

```ts
if (effectiveAuth) {
  app.use('/a2a', authMiddleware(effectiveAuth))
  app.use('/a2a/*', authMiddleware(effectiveAuth))
}
```

The well-known discovery document (`/.well-known/agent.json`) is mounted
by `createA2ARoutes()` at the app root and therefore falls outside the
`/a2a/**` pattern, leaving it publicly reachable per the A2A spec.

### 3. `/metrics` TODO comment

Added an inline TODO above the Prometheus metrics mount noting that the
endpoint is currently public and should be moved to an internal-only
listener (or protected by an IP allow-list / ingress rule) in production.

```ts
// TODO(security): `/metrics` is currently mounted on the public app and
// bypasses auth. For production deployments this should be exposed on an
// internal-only port (e.g. a separate Hono listener bound to 127.0.0.1)
// or protected by an IP allow-list. …
```

## Routes matrix

| Path                        | Auth required? | Rationale                       |
|-----------------------------|----------------|---------------------------------|
| `/.well-known/agent.json`   | No             | A2A discovery must be public    |
| `/a2a` (JSON-RPC)           | Yes (if auth)  | Task submission endpoint        |
| `/a2a/tasks`, `/a2a/tasks/*`| Yes (if auth)  | Task lifecycle + messages       |
| `/metrics`                  | No (TODO)      | Should move to internal port    |

## SafetyMonitor Wiring

### Files changed
- `packages/server/src/app.ts`

### Discovery
`createSafetyMonitor` IS exported from `@dzupagent/core` via
`packages/core/src/index.ts:540`:

```ts
export { createSafetyMonitor, getBuiltInRules } from './security/monitor/index.js'
```

### Implementation

1. Added the import at the top of `app.ts`:
   ```ts
   import { createSafetyMonitor } from '@dzupagent/core'
   ```

2. Added `disableSafetyMonitor?: boolean` to `ForgeServerConfig` with a
   docstring explaining that the server attaches a monitor by default.

3. Added the wiring inside `createForgeApp()` right after `eventGateway`
   is resolved:

   ```ts
   // --- Runtime SafetyMonitor ---
   if (!config.disableSafetyMonitor) {
     createSafetyMonitor({ eventBus: config.eventBus })
   }
   ```

   Note: `createSafetyMonitor({ eventBus })` auto-attaches the monitor to
   the supplied event bus in its factory (see
   `packages/core/src/security/monitor/safety-monitor.ts:139-142`), so
   calling `attach()` again would detach-then-reattach. The single call
   is sufficient to wire `tool:error` and `memory:written` scanning for
   prompt-injection / memory-poisoning / tool-abuse violations that then
   emit `safety:violation`, `safety:blocked`, or `safety:kill_requested`
   back onto the shared bus.

   The monitor is attached to `config.eventBus` (a `DzupEventBus`),
   because that is the type its `attach()` method accepts — the server's
   `EventGateway` is a separate SSE/WS fan-out abstraction that does not
   satisfy the monitor's contract.

## Validation

Server typecheck (direct, after `yarn workspace @dzupagent/core build`):

```
cd packages/server && yarn typecheck
yarn run v1.22.22
$ tsc --noEmit
Done in 40.84s.
```

Server typechecks with zero errors.

## Final Server Typecheck

Running `yarn typecheck --filter @dzupagent/server` from the repo root
exercises the full dependency graph. The `@dzupagent/server` package and
all of its upstream builds that it depends on (core, agent, agent-adapters,
memory, memory-ipc, etc.) succeed. The Turbo run fails on
`@dzupagent/context#typecheck` due to a pre-existing error unrelated to
these changes:

```
@dzupagent/context:typecheck: src/message-manager.ts(58,7): error TS2741:
  Property 'eventBus' is missing in type '{ maxMessages: number; … }'
  but required in type 'Omit<Required<MessageManagerConfig>, …>'.
```

This error exists on `main` before any server-package edits were made and
has no connection to the A2A auth, SafetyMonitor, CORS, metadata, or
OpenAI-compat middleware work in this task batch. The server package
itself typechecks cleanly when run directly.
