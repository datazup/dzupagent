# 14. API Surface and Contracts

## Repository Overview
This review targets the `dzupagent` monorepo with contract focus on `packages/server` (HTTP/A2A/OpenAI-compatible routes), `packages/core` (event and protocol contracts), `packages/playground` (primary API consumer), and `packages/create-dzupagent` (marketplace consumer path).  
Secondary artifacts under `out/` were used as supplemental inventory context, including `out/code-features-current/extracted/dzupagent-packages-server.md` (reported `routes=139`) and `out/code-features-current/scored/dzupagent-packages-server.md` (18 detected API feature groups). Source code in the repo was treated as contract truth when artifacts and runtime behavior diverged.

## Interface Surface
The repo is strongly API-centric with a large mixed internal/external contract surface:

- `@dzupagent/server` is the main network contract owner through `createForgeApp` in `packages/server/src/app.ts`, mounting:
  - Internal platform routes under `/api/*` (runs, agents, memory, events, marketplace, clusters, schedules, prompts, personas, etc.).
  - OpenAI-compatible routes under `/v1/*` (`/v1/chat/completions`, `/v1/models`).
  - A2A routes mounted at root (`/a2a`, `/a2a/tasks*`, `/.well-known/agent.json`).
- A2A contracts are split across:
  - REST and JSON-RPC handlers in `packages/server/src/routes/a2a/*`.
  - Task model/state contracts in `packages/server/src/a2a/task-handler.ts`.
  - Core protocol client contracts in `packages/core/src/protocol/a2a-client-adapter.ts` and `a2a-json-rpc.ts`.
- Event contracts are centered in `packages/core/src/events/event-types.ts` (`DzupEvent` union) and wrapped for streaming as `EventEnvelope` (`version: 'v1'`) in `packages/server/src/events/event-gateway.ts`, exposed by `/api/events/stream`.
- Public package contract surface is broad:
  - `@dzupagent/core` exports 9 entry points (including subpath APIs like `./stable`, `./advanced`, `./facades`).
  - `@dzupagent/server` exports a very large set of route factories, middleware, persistence stores, A2A/OpenAI helpers, and types from `packages/server/src/index.ts`.
  - Most other packages export a single root entry point.
- Producer-consumer contract consumers inside the monorepo include:
  - Playground API calls (`packages/playground/src/composables/useApi.ts`, stores/views).
  - `create-dzupagent` marketplace template fetch path (`packages/create-dzupagent/src/utils.ts`).
- Connector and adapter interfaces are explicit contract surfaces:
  - Canonical connector tool contract in `packages/core/src/tools/connector-contract.ts`.
  - Adapter contract types in `packages/adapter-types/src/index.ts`, re-exported via `packages/agent-adapters/src/types.ts`.

## Strong Areas
- Connector contract reuse is disciplined. `BaseConnectorTool` is centralized in core and reused by connectors/browser/documents/scraper packages, reducing parallel type drift.
- Contract conformance tests exist for key extension surfaces:
  - Connector contract conformance (`packages/connectors/src/__tests__/connector-contract-conformance.test.ts`).
  - Adapter conformance contract tests (`packages/agent-adapters/src/__tests__/adapter-conformance.contract.test.ts`).
- OpenAI compatibility surface is relatively well-defined:
  - Request validation and error shaping (`packages/server/src/routes/openai-compat/request-mapper.ts`).
  - Focused adapter tests (`packages/server/src/__tests__/openai-adapter.test.ts`).
- Event streaming has a typed envelope with explicit version marker (`EventEnvelope.version = 'v1'`) rather than opaque ad-hoc payloads.
- Public exports are explicit and discoverable via `package.json` `exports` fields across packages, which improves dependency safety for consumers compared to deep-import-only patterns.

## Findings
1. **Critical: A2A server and playground contracts are incompatible at path and payload shape level.**  
Server A2A REST routes are mounted at `/a2a/*` and return raw task payloads or `{ tasks }` (`packages/server/src/routes/a2a/task-routes.ts`), while playground calls `/api/a2a/*` and expects `{ success, data, count }` (`packages/playground/src/views/A2ATasksView.vue`, `A2ATaskDetailView.vue`, `packages/playground/src/types.ts`). This is a direct runtime break risk, not just a typing mismatch.

2. **Critical: Core A2A protocol client contract drifts from server JSON-RPC contract.**  
`A2AClientAdapter` expects JSON-RPC `result.status.state` and uses state value `'canceled'` (`packages/core/src/protocol/a2a-client-adapter.ts`), but server JSON-RPC handlers return the flat task record (`state` at top level) with `'cancelled'` spelling (`packages/server/src/routes/a2a/jsonrpc-handlers.ts`, `packages/server/src/a2a/task-handler.ts`). Producer-consumer mismatch here can fail interop even within the same monorepo.

3. **Critical: Marketplace contract is split into mutually incompatible endpoint families.**  
Server implements `/api/marketplace/catalog*` CRUD/search (`packages/server/src/routes/marketplace.ts`). Playground expects `/api/marketplace/agents`, `/api/marketplace/install`, and `DELETE /api/marketplace/:id` (`packages/playground/src/stores/marketplace-store.ts`). `create-dzupagent` expects `/api/marketplace/templates` (`packages/create-dzupagent/src/utils.ts`). These surfaces cannot all be correct simultaneously.

4. **High: DTO/type duplication across packages is already causing drift in state and field semantics.**  
Server A2A state includes `'input-required'` and uses `pushNotificationConfig` (`packages/server/src/a2a/task-handler.ts`), while playground A2A type omits `'input-required'` and uses `pushNotification` (`packages/playground/src/types.ts`). The same domain object has diverged names and state sets across producer/consumer code.

5. **High: Route boundary contract enforcement exists but is effectively unused; response envelope conventions are inconsistent.**  
A shared route validator exists (`packages/server/src/validation/route-validator.ts`) but is not used by route handlers (only validator tests reference it). Route groups return mixed envelope styles: raw objects (e.g. `personas`, `prompts`, `clusters`), `{ data: ... }`, `{ success: true, data: ... }`, and ad-hoc keys like `{ tasks }` / `{ personas }` / `{ prompts }`. This increases client fragility and raises integration cost.

6. **Medium: Extension route plugin contract trades compile-time compatibility for `unknown` and runtime casting.**  
`ServerRoutePlugin.createRoutes(): unknown` (`packages/server/src/route-plugin.ts`) is cast at mount-time in app bootstrap (`packages/server/src/app.ts`). This weakens compile-time compatibility guarantees for plugin ecosystems and increases runtime failure probability on version skew.

7. **Medium: `@dzupagent/runtime-contracts` is type-only despite being positioned as cross-runtime contract authority.**  
The package exports TS interfaces/unions without runtime schema validators or explicit schema versioning (`packages/runtime-contracts/src/index.ts`), and tests validate constructability only (`packages/runtime-contracts/src/__tests__/contracts.test.ts`). This is insufficient for wire-level or polyglot integration safety.

8. **Medium: Contract tests are strong within modules but weak across real producer-consumer boundaries.**  
Playground API tests mock `useApi` and assert mocked response shapes (`packages/playground/src/__tests__/a2a-views.test.ts`, `marketplace.test.ts`), so server-client wire drift is not detected by default CI. Similar isolation exists between core A2A adapter tests and server A2A route behavior.

## Client-Server Or Producer-Consumer Drift
| Producer | Consumer | Drift |
|---|---|---|
| Server A2A REST routes at `/a2a/tasks*` with raw task payloads / `{ tasks }` (`packages/server/src/routes/a2a/task-routes.ts`) | Playground A2A views call `/api/a2a/tasks*` and read `response.data` (`packages/playground/src/views/A2ATasksView.vue`, `A2ATaskDetailView.vue`) | Path mismatch and envelope mismatch; likely runtime failure or empty UI state. |
| Server A2A task model uses `state` on root, includes `'input-required'`, field `pushNotificationConfig` (`packages/server/src/a2a/task-handler.ts`) | Playground A2A types omit `'input-required'`, use `pushNotification` (`packages/playground/src/types.ts`) | Domain model drift in enum values and field names. |
| Server A2A JSON-RPC handlers return flat task via `createJsonRpcSuccess(..., task)` (`packages/server/src/routes/a2a/jsonrpc-handlers.ts`) | Core A2A client expects `result.status.state` (`packages/core/src/protocol/a2a-client-adapter.ts`) | Structural JSON-RPC result mismatch. |
| Server A2A state uses `'cancelled'` | Core A2A client stream termination checks `'canceled'` | Spelling mismatch in terminal-state semantics. |
| Server marketplace supports `/api/marketplace/catalog*` only (`packages/server/src/routes/marketplace.ts`) | Playground marketplace store uses `/api/marketplace/agents`, `/install`, `DELETE /api/marketplace/:id` (`packages/playground/src/stores/marketplace-store.ts`) | Endpoint family mismatch. |
| Server marketplace supports catalog endpoints | `create-dzupagent` fetches `/api/marketplace/templates` (`packages/create-dzupagent/src/utils.ts`) | Missing producer endpoint for consumer expectation. |
| `DzupEvent` union does not include `a2a:task_*` or `agent:cancelled` (`packages/core/src/events/event-types.ts`) | A2A event stream composable listens for `a2a:task_updated`, `a2a:task_created`, `agent:cancelled` (`packages/playground/src/composables/useA2AEventStream.ts`) | Subscription taxonomy drift; missed refresh triggers likely. |

## Compatibility And Evolution Review
- Versioning discipline is partial:
  - Positive: OpenAI-compatible routes are explicitly versioned under `/v1/*`.
  - Positive: Event envelope carries `version: 'v1'`.
  - Gap: Main internal HTTP contract under `/api/*` is effectively unversioned, so behavior/shape shifts become breaking without explicit negotiation.
- Package semver is still `0.2.0` across major surfaces (`@dzupagent/core`, `@dzupagent/server`, `@dzupagent/runtime-contracts`), which permits rapid evolution but weakens external compatibility expectations.
- Changesets are configured (`updateInternalDependencies: patch`), which helps release hygiene but does not protect wire-contract compatibility by itself.
- Public API breadth is large (especially `@dzupagent/server` and `@dzupagent/core`), increasing accidental break surface unless explicit contract ownership and compatibility tests are tightened.
- Extension safety is currently moderate:
  - Flexible plugin mounting exists.
  - Contract guarantees are weak for plugin route compatibility (`unknown` route type, no explicit plugin API version handshake).
- Maintainability risk is elevated by contract duplication across server/playground/core/create-dzupagent instead of shared generated or canonical DTO contracts.

## Recommended Contract Improvements
1. Define one canonical HTTP contract source for server endpoints and generate both server validators and typed client artifacts from it (Zod-first + generated client or OpenAPI-first).
2. Immediately converge A2A HTTP contracts:
   - Choose one base path (`/a2a` or `/api/a2a`) and keep compatibility aliases during migration.
   - Standardize list/detail/message response envelopes.
3. Align A2A JSON-RPC schema between core adapter and server:
   - Decide flat `state` vs nested `status.state`.
   - Normalize terminal-state spelling (`canceled` vs `cancelled`) with explicit mapping and deprecation windows.
4. Create shared cross-package DTO modules for active producer-consumer seams (at minimum A2A and marketplace) and consume them from server, playground, and create-dzupagent.
5. Enforce route-boundary validation usage in CI:
   - Require `validateBody`/`validateQuery` (or replacement) on mutable routes.
   - Add lint rule/check to prevent direct unvalidated `c.req.json()` in route handlers.
6. Adopt a uniform API envelope policy for `/api/*` (for example `{ data, error, meta }`) and apply adapters for legacy routes.
7. Add true contract integration tests:
   - Run playground store/view API calls against a live test app from `@dzupagent/server`.
   - Run core A2A client adapter tests against server A2A JSON-RPC endpoints.
8. Add explicit compatibility metadata for extensions:
   - `ServerRoutePlugin` should declare plugin API version and supported server/Hono version range.
   - Reject/disable incompatible plugins at mount time with deterministic diagnostics.
9. Add runtime validation and schema version tags to `@dzupagent/runtime-contracts` so contracts are enforceable beyond TypeScript compile-time.

## Overall Assessment
The repository has a strong foundation of typed contracts and package-level conformance testing, but active producer-consumer seams currently show serious drift.  
API contract quality is **moderate at design level, high-risk at integration boundaries** due to A2A and marketplace mismatches, duplicated DTO ownership, and inconsistent wire envelopes.  
Short-term priority should be contract convergence on active client paths; medium-term priority should be generated/shared contracts plus end-to-end compatibility tests.