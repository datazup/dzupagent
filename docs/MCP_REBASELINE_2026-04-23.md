# MCP Rebaseline (2026-04-23)

## Why This Exists

The workspace already contains substantial MCP implementation work, but it does not yet have one authoritative execution document that separates:

- what is already implemented in `dzupagent`
- what is only partially productized
- what still needs to be built to support app-level MCP publishing from `apps/*/apps/api`
- what verification is required to keep the rollout from drifting

This document is the focused source of truth for the MCP rollout across:

- `dzupagent/`
- `apps/testman-app/`
- `apps/research-app/`
- `apps/codev-app/`
- `apps/ai-saas-starter-kit/`

It is intentionally execution-oriented. It should be updated when plan status changes, not treated as a static architecture note.

## Scope

This rebaseline covers two distinct MCP directions that must not be conflated:

1. External MCP consumption
   - `dzupagent` acting as an MCP client and manager for external servers
   - runtime/tool-resolution integration in `@dzupagent/server`

2. Local MCP publishing
   - `dzupagent` providing the canonical server-side publishing kit
   - `apps/*/apps/api` exposing their own tools and resources as MCP servers

Rule:
- external MCP management and local MCP publishing may share protocol and transport utilities, but they are different trust boundaries and must remain different product surfaces

Current execution note:
- the active implementation wave is intentionally focused on framework publishing support in `@dzupagent/core` and `@dzupagent/express`
- `packages/server` hardening remains valid work, but it is explicitly out of scope for this wave

## Current Reality

### What Is Already Implemented

The core MCP substrate in `dzupagent` is real and should be extended rather than replaced:

- `@dzupagent/core`
  - `mcp-client.ts`
  - `mcp-manager.ts`
  - `mcp-tool-bridge.ts`
  - `mcp-server.ts`
  - `mcp-resources.ts`
  - `mcp-sampling.ts`
  - `mcp-reliability.ts`
  - `mcp-security.ts`
  - `mcp-connection-pool.ts`
- `@dzupagent/server`
  - `/api/mcp/*` lifecycle routes
  - runtime MCP tool resolution via `mcp:*` selectors
- `@dzupagent/connectors`
  - `MCPAsyncToolResolver` for compiler/runtime-backed lazy MCP tool resolution

There are also two useful app-side patterns already present:

- `apps/testman-app/apps/api`
  - publishes app features via `DzupAgentMCPServer`
  - exposes a tool-only JSON-RPC endpoint
- `apps/research-app/apps/api`
  - has tenant-aware MCP auth/config management and resource/tool surfaces
  - currently implemented as an app-local MCP stack rather than a shared dzupagent publishing kit

### What Is Not Done Yet

- the `dzupagent/server` MCP control plane is not hardened enough by default
- app MCP publishing patterns are already drifting from each other
- app-level auth/context conventions for published MCP servers are not standardized yet
- only `testman-app` and `research-app` have been migrated onto the shared `@dzupagent/express` publishing path so far
- operator CLI UX and onboarding are still incomplete

## Drift Diagnosis

The main risk is not missing MCP support. The main risk is implementation drift across three partially overlapping models:

1. `dzupagent/core` MCP model
   - strong substrate
   - canonical publishing surface now exists, but no app adopters are migrated yet

2. `testman-app` MCP publishing model
   - simple, lightweight, tool-only
   - no shared tenant/auth/resource contract

3. `research-app` MCP management/publishing model
   - richer tenant-aware behavior
   - implemented outside the shared dzupagent publishing kit

This creates the following drift classes:

- protocol drift
  - different JSON-RPC compatibility behavior across repos
- auth drift
  - different bearer/API-key/tenant handling patterns
- transport drift
  - app-local HTTP wrappers instead of one shared publishing adapter
- schema drift
  - different tool result, resource, and error envelopes
- request-context drift
  - tenant/user context may still be resolved differently per app even though the shared router now supports request-scoped server resolution
- local dependency-link drift
  - consumer repos can fall back to the public registry when their `portal:` / workspace-link policy does not cover newly adopted framework packages
- verification drift
  - no shared compatibility fixture proving identical behavior across publisher implementations

## Target Architecture

### Canonical Roles

- `@dzupagent/core`
  - owns protocol types
  - owns the canonical MCP publishing server abstraction
  - owns shared resources/sampling/tool bridge logic

- `@dzupagent/express`
  - owns Express transport glue for app-published MCP servers
  - should expose a shared router factory instead of app-local JSON-RPC route logic

- `@dzupagent/server`
  - owns external MCP control plane
  - owns secure operator routes and onboarding UX
  - should not become the required publishing transport for app repos

- `apps/*/apps/api`
  - own business logic, auth resolution, tenant context, and actual tool/resource handlers
  - should not own bespoke MCP protocol handling once the shared publishing kit exists

### Publishing Model

The canonical app publishing contract should support:

- tools
- resources
- resource templates
- optional sampling handler
- capability advertisement
- auth/context hooks
- observability hooks

First wave should prefer read-heavy, tenant-scoped, low-side-effect MCP publishing.

## Workstream Status

Legend:

- `done`: enough evidence exists in the live workspace
- `in progress`: partially defined or partially implemented, but not yet authoritative
- `not done`: still missing or too fragmented to rely on

| Workstream | Status | Evidence |
| --- | --- | --- |
| Core MCP substrate in `dzupagent` | done | Client/manager/bridge/server/resources/sampling/security/reliability/connection pool all exist. |
| Runtime MCP consumption in `dzupagent/server` | done | `mcp:*` selector resolution and route-level manager integration exist. |
| Compiler/runtime lazy MCP resolution | done | `MCPAsyncToolResolver` exists in `@dzupagent/connectors`. |
| Canonical MCP publishing core for apps | done | `DzupAgentMCPServer` now supports `initialize`, notifications/`id:null`, resources, capability advertisement, structured tool results, and optional sampling handler support with focused tests. |
| Shared app publishing transport glue | done | `@dzupagent/express` now exposes `createMcpRouter(...)`, request-scoped server resolution, and reusable MCP request-context auth helpers for tenant-aware publishers. |
| App adopter standardization | in progress | `testman-app` and `research-app` are now migrated to the shared express router; `codev-app` and `ai-saas-starter-kit` are not migrated yet. |
| External MCP control-plane hardening | not done | `/api/mcp/*` still needs stronger authz, redaction, and transport policy, but this is parked outside the current framework wave. |
| Operator CLI onboarding and doctor flows | not done | `dzup mcp` UX is still mostly placeholder behavior. |
| Shared compatibility verification across repos | in progress | `@dzupagent/test-utils` now exports a reusable MCP publisher compatibility suite, and `testman-app` consumes it. `research-app` still uses app-local publish-route assertions while its route harness is stabilized against the new shared auth helper. |
| Drift-control documentation and rollout sequencing | in progress | This document now reflects the framework-only execution wave and updated next steps. |

## Focused Execution Order

Work should proceed in this order to minimize rework:

1. Freeze architecture and contract boundaries
2. Expand shared publishing core in `@dzupagent/core`
3. Add shared Express publishing adapter
4. Migrate `testman-app`
5. Migrate `research-app`
6. Standardize reusable auth/context helpers for published MCP servers
7. Add shared compatibility fixtures and rollout gates
8. Add read-first adoption in `codev-app`
9. Add reference/scaffold support in `ai-saas-starter-kit`
10. Revisit `packages/server` hardening as a separate control-plane track

Reason:

- protocol clarity must come before multi-app rollout
- app migrations should prove the shared path rather than invent it
- app auth/context conventions should be standardized before broad adoption, even though request-scoped server resolution is now available
- onboarding should follow the stable implementation, not precede it

## Detailed Next Tasks

### Task Group A — Freeze The Canonical MCP Contract

Goal:
- make this document and the shared package boundaries authoritative before further implementation diverges

Required output:
- this document remains the tracked source of truth
- any follow-on MCP work references this rollout order

Files to use as anchors:
- `packages/core/src/mcp/mcp-server.ts`
- `packages/core/src/mcp/mcp-client.ts`
- `packages/server/src/routes/mcp.ts`
- `apps/testman-app/apps/api/src/lib/dzupagent-mcp.ts`
- `apps/research-app/apps/api/src/mcp/server.ts`

Verification:
- no code verification required for this planning checkpoint
- plan status changes must be reflected here in the same execution wave

Exit rule:
- do not add new app-local MCP protocol code before Task Groups B-D are started

### Task Group B — Harden External MCP Management In `dzupagent/server`

Goal:
- make `/api/mcp/*` safe enough to serve as the external MCP control plane

Current status:
- intentionally deferred from the active framework wave
- do not mix this work into app-publishing changes until adopter migrations are complete

Required work:
- add admin-only or capability-based authz on `/api/mcp/*`
- redact `env`, `headers`, and secret refs from route responses
- separate safe response DTOs from stored server definitions
- restrict API-managed transport policy
  - allowlisted HTTP/SSE hosts
  - no arbitrary `stdio` from external control plane
- add outbound URL policy validation for external MCP endpoints

Likely files:
- `packages/server/src/app.ts`
- `packages/server/src/routes/mcp.ts`
- `packages/core/src/mcp/mcp-registry-types.ts`
- possibly new server-side authz/policy helpers

Verification:
- `cd dzupagent && yarn workspace @dzupagent/server typecheck`
- `cd dzupagent && yarn workspace @dzupagent/server test src/__tests__/mcp-routes.test.ts src/__tests__/mcp-integration.test.ts`
- add targeted denial-path coverage for:
  - non-admin route denial
  - secret redaction
  - rejected unsafe transport/endpoint policy

Exit rule:
- do not mark this done without explicit denial-path and redaction tests

### Task Group C — Expand `DzupAgentMCPServer` Into The Canonical Publishing Core

Goal:
- turn `DzupAgentMCPServer` into the shared, protocol-correct publishing base for app APIs

Current status:
- completed for the framework wave

Done in this wave:
- added `initialize`
- added notification-compatible handling for requests without `id`
- added support for `id: null`
- added `resources/list`
- added `resources/templates/list`
- added `resources/read`
- added capability advertisement
- added optional sampling handler support
- added extensible registration/list methods for resources and resource templates
- added focused core tests for the new protocol surface

Required work:
- add `initialize`
- support `id: null` and notification-compatible handling
- add resource support:
  - `resources/list`
  - `resources/templates/list`
  - `resources/read`
- add capability advertisement
- add optional sampling hook support behind explicit options
- define extensible tool/resource registration APIs

Likely files:
- `packages/core/src/mcp/mcp-server.ts`
- supporting type files under `packages/core/src/mcp/`

Verification:
- `cd dzupagent && yarn workspace @dzupagent/core test`
- `cd dzupagent && yarn workspace @dzupagent/core test src/mcp/__tests__/mcp-server.test.ts`
- `cd dzupagent && yarn workspace @dzupagent/core typecheck`
- add dedicated focused tests for:
  - initialize response
  - invalid request envelope
  - `id: null`
  - tool error envelope
  - resource list/read behavior

Exit rule:
- do not migrate app publishers onto the shared kit until the shared core covers tools and resources cleanly

### Task Group D — Add Shared App Publishing Transport Glue

Goal:
- give app repos one blessed way to expose MCP over Express

Current status:
- completed for the framework wave

Done in this wave:
- added `createMcpRouter(...)` in `@dzupagent/express`
- standardized JSON-RPC invalid-request and internal-error envelopes at the router layer
- added notification handling that returns HTTP `204`
- added optional helper routes for tools, resources, and resource templates
- added auth and lifecycle hook entry points for app repos
- added request-scoped server resolution so publishers can bind handlers to tenant/user context per request
- added focused router tests

Required work:
- add a router factory in `@dzupagent/express`
- standardize:
  - request parsing
  - JSON-RPC response handling
  - auth/context hook integration
  - route-level error mapping
  - optional discovery routes like `/mcp/tools`

Likely files:
- `packages/express/`
- possibly small companion exports in `packages/core`

Verification:
- `cd dzupagent && yarn workspace @dzupagent/express build`
- `cd dzupagent && yarn workspace @dzupagent/express test src/__tests__/mcp-router.test.ts`
- `cd dzupagent && yarn workspace @dzupagent/express typecheck`
- add focused tests in the adapter package for:
  - valid MCP request routing
  - invalid request handling
  - auth/context hook invocation

Exit rule:
- once available, new app MCP endpoints must use this adapter rather than custom route glue

### Task Group E — First Adopter Migration: `testman-app`

Goal:
- prove the shared publishing path with the simplest existing MCP publisher

Current status:
- completed for the first adopter wave

Done in this wave:
- migrated the MCP route to `createMcpRouter(...)`
- preserved the existing tool surface while keeping resource/template helper routes disabled
- tightened shared invalid-request validation so malformed MCP IDs are still rejected after migration
- added focused integration coverage for:
  - routed valid MCP requests
  - notification `204` behavior
  - invalid-request handling
  - `/mcp/tools`
  - auth middleware execution
- fixed local consumer-link drift in `testman-app` by adding missing `portal:` resolutions for the newly consumed framework packages

Required work:
- migrate `testman-app` from local `DzupAgentMCPServer` route glue to `createMcpRouter(...)`
- preserve existing published tools:
  - `generate-test-cases`
  - `extract-requirements`
  - `query-rag`
- keep behavior unchanged before expanding scope
- add a parity test proving:
  - existing auth still wraps the MCP endpoint
  - `/mcp/tools` output is stable
  - invalid JSON-RPC requests still return a compliant envelope
  - notification requests do not produce a response body

Likely files:
- `apps/testman-app/apps/api/src/lib/dzupagent-mcp.ts`
- `apps/testman-app/apps/api/src/routes/ai-observability.routes.ts`

Verification:
- `cd apps/testman-app && yarn workspace @testman-app/api run typecheck`
- `cd apps/testman-app && yarn test:api:integration`
- add a focused API test for the migrated MCP route before marking done

Completed verification for this wave:
- `cd apps/testman-app && yarn workspace @testman-app/api run typecheck`
- `cd apps/testman-app && yarn workspace @testman-app/api test src/tests/integration/ai-observability.routes.test.ts`

Exit rule:
- parity tests must pass before adding any new tool/resource publishing features in this app

### Task Group F — Second Adopter Migration: `research-app`

Goal:
- prove the shared publishing path on a tenant-aware, resource-heavy app

Current status:
- completed for the second adopter wave

Done in this wave:
- added request-scoped server resolution support in `@dzupagent/express`
- kept the existing REST management/control surface under cookie auth
- added a separate JSON-RPC publish surface at `/api/research/mcp/publish`
- authenticated the publish surface with MCP API keys rather than session cookies
- bound published tool/resource handlers to tenant/user context per request
- exposed resources and resource templates through the shared publisher path
- added focused integration coverage for:
  - missing API key denial
  - valid publish helper route access
  - `initialize`
  - notification `204`
  - invalid-request handling

Required work:
- keep tenant-aware API key auth
- preserve external MCP management/client behavior where still needed
- move app publishing of tools/resources onto the shared dzupagent publishing kit
- use this app to prove resource-template and resource-read support

Likely files:
- `apps/research-app/apps/api/src/mcp/server.ts`
- `apps/research-app/apps/api/src/routes/research/mcp.routes.ts`
- related controllers/schemas

Verification:
- `cd apps/research-app && yarn workspace @research-app/api typecheck`
- `cd apps/research-app && yarn workspace @research-app/api test`

Completed verification for this wave:
- `cd apps/research-app && yarn install`
- `cd apps/research-app && yarn workspace @research-app/api typecheck`
- `cd apps/research-app && yarn workspace @research-app/api test src/tests/integration/mcp-publish.routes.test.ts`

Exit rule:
- do not collapse external MCP management concerns into the shared publishing layer; keep responsibilities separate

### Task Group G — Shared Auth/Context Helpers And Compatibility Fixtures

Goal:
- stop each adopter app from inventing a slightly different auth/context wrapper around the shared router

Current status:
- partially completed in the current framework wave

Done in this wave:
- `@dzupagent/express` now exports reusable MCP request-context helpers:
  - `createMcpRequestContextAuth(...)`
  - `extractMcpCredential(...)`
  - `getMcpRequestContext(...)`
  - `requireMcpRequestContext(...)`
- `research-app` publish routing now uses the shared request-context auth helper instead of app-local credential parsing and request mutation
- `@dzupagent/test-utils` now exports `describeMcpPublisherCompatibilitySuite(...)`
- the shared compatibility suite now covers:
  - `initialize`
  - `tools/list`
  - `tools/call`
  - invalid request
  - `id: null`
  - notifications
  - optional resources
  - optional resource templates
- `testman-app` publish-route tests now consume the shared compatibility suite

Remaining work:
- migrate `research-app` onto the shared compatibility suite after its publish-route harness is stabilized
- decide whether the compatibility suite should grow explicit assertions for capability payloads and error envelopes beyond invalid-request
- extract a tiny shared Express test harness helper if more adopters need route-level MCP contract tests

Required work:
- define one reusable pattern for API-key or bearer-token backed MCP publish auth
- define one shared request-context contract for:
  - tenantId
  - userId
  - optional actor/service metadata
- add a reusable compatibility fixture covering:
  - `initialize`
  - `tools/list`
  - `tools/call`
  - invalid request
  - `id: null`
  - notifications
  - resources
  - resource templates
- make future adopters consume that fixture rather than re-implementing ad hoc route assertions

Verification:
- `cd dzupagent && yarn workspace @dzupagent/express test src/__tests__/mcp-context.test.ts src/__tests__/mcp-router.test.ts`
- `cd dzupagent && yarn workspace @dzupagent/express typecheck`
- `cd dzupagent && yarn workspace @dzupagent/test-utils test src/__tests__/mcp-compatibility.test.ts`
- `cd dzupagent && yarn workspace @dzupagent/test-utils typecheck`
- `cd apps/testman-app && yarn workspace @testman-app/api test src/tests/integration/ai-observability.routes.test.ts`
- `cd apps/testman-app && yarn workspace @testman-app/api run typecheck`
- `research-app` remains partially verified in this wave:
  - `yarn install` completed after route changes
  - full API typecheck is currently blocked by broader `@dzupagent/core` portal/declaration issues in the app workspace
  - focused publish-route test currently needs a harness cleanup pass before it can be treated as a stable gate again

Exit rule:
- do not widen adopter rollout again until at least one tenant-aware adopter also consumes the shared compatibility suite cleanly

### Task Group H — Read-First Adopters: `codev-app` And `ai-saas-starter-kit`

Goal:
- expand adoption without increasing side-effect risk early

`codev-app` first-wave candidates:
- adapter monitor inventory/status
- persona/tool capability reads
- diagnostics/status queries

`ai-saas-starter-kit` first-wave role:
- reference implementation
- scaffold target for future app repos

Verification:
- `cd apps/codev-app && yarn workspace @codev-app/api typecheck`
- `cd apps/codev-app && yarn test:integration`
- `cd apps/ai-saas-starter-kit && yarn typecheck`
- `cd apps/ai-saas-starter-kit && yarn test`

Exit rule:
- start read-only unless there is a strong product reason to expose mutation tools immediately

### Task Group I — Operator UX And Onboarding

Goal:
- make MCP use and MCP publishing discoverable and supportable

Required work:
- improve `dzup mcp` UX:
  - `list`
  - `doctor`
  - `bootstrap`
  - `test`
  - `bind`
- add `create-dzupagent` support for app publishing templates
- add focused docs:
  - consume external MCP
  - publish app APIs as MCP
  - auth and tenancy model

Verification:
- `cd dzupagent && yarn workspace @dzupagent/server test src/__tests__/cli-commands-smoke.test.ts`
- add CLI smoke tests for new `dzup mcp` behavior
- add scaffold smoke coverage when template support lands

Exit rule:
- do not claim MCP product readiness if onboarding still requires reading internal code to wire basic publisher flows

### Task Group J — Anti-Drift Quality Gates

Goal:
- stop MCP behavior from fragmenting across repos after rollout starts

Required work:
- add a shared MCP compatibility fixture suite covering:
  - `tools/list`
  - `tools/call`
  - invalid request
  - `id: null`
  - tool error envelopes
  - resources
- require app publishers to use the shared adapter
- document policy:
  - no bespoke app-local JSON-RPC envelope handling unless explicitly justified
  - no new MCP auth model without shared review
- standardize local consumer linking for framework packages:
  - if an app repo develops against local `dzupagent` packages, its root package manager config must resolve all consumed internal packages through `portal:` / workspace links rather than relying on registry fallbacks
- keep publish and control-plane surfaces separate:
  - external MCP management may stay REST/control-plane oriented
  - local app publishing must use the shared JSON-RPC publisher path rather than being folded into management routes

Verification:
- `dzupagent` targeted core/server tests
- adopter app API typecheck + integration tests

Next focused tasks from here:
- stabilize `research-app` publish-route verification against the shared auth helper, then move it onto `describeMcpPublisherCompatibilitySuite(...)`
- decide whether to place a shared Express MCP dispatch harness in `@dzupagent/test-utils` for adopter route tests
- migrate `codev-app` with a read-only first wave
- normalize local-link policy in the remaining consumer repos before further framework package adoption
- release checklist updated with MCP-specific gates

Exit rule:
- do not widen app adoption until the compatibility suite exists and both `testman-app` and at least one tenant-aware adopter pass it

## Verification Matrix

Use the narrowest proof first, then widen only when contracts move.

### `dzupagent`

- `cd dzupagent && yarn workspace @dzupagent/core test`
- `cd dzupagent && yarn workspace @dzupagent/server typecheck`
- `cd dzupagent && yarn workspace @dzupagent/server test src/__tests__/mcp-routes.test.ts src/__tests__/mcp-integration.test.ts`
- `cd dzupagent && yarn workspace @dzupagent/flow-compiler test`
- `cd dzupagent && yarn workspace @dzupagent/express build`

### `apps/testman-app`

- `cd apps/testman-app && yarn workspace @testman-app/api run typecheck`
- `cd apps/testman-app && yarn test:api:integration`

### `apps/research-app`

- `cd apps/research-app && yarn workspace @research-app/api typecheck`
- `cd apps/research-app && yarn workspace @research-app/api test`

### `apps/codev-app`

- `cd apps/codev-app && yarn workspace @codev-app/api typecheck`
- `cd apps/codev-app && yarn test:integration`

### `apps/ai-saas-starter-kit`

- `cd apps/ai-saas-starter-kit && yarn typecheck`
- `cd apps/ai-saas-starter-kit && yarn test`

## Code Quality Rules For This Rollout

1. Centralize protocol logic.
   - `@dzupagent/core` owns MCP protocol types and the publishing core.

2. Centralize HTTP transport glue.
   - app repos should use a shared adapter, not carry independent JSON-RPC route logic long-term.

3. Separate control plane from publishing plane.
   - external MCP server management is not the same as publishing an app as an MCP server.

4. Keep app code focused on business logic.
   - auth resolution, tenant context, tool/resource handlers belong in apps
   - protocol envelopes and transport glue do not

5. Prefer read-first rollout.
   - publish read-only tools/resources before side-effecting tools unless there is a strong reason not to

6. Require targeted tests before widening scope.
   - do not replace focused MCP tests with broad “full repo test” claims

7. Update this document when status changes.
   - plan status should trail real verification by zero turns, not several sessions

## Exit Criteria

Do not call the MCP rollout complete until all of the following are true:

- external MCP management in `dzupagent/server` is admin-safe and secret-safe
- `DzupAgentMCPServer` covers the required publishing protocol surface
- a shared Express publishing adapter exists
- `testman-app` is migrated to the shared publishing path
- `research-app` is migrated to the shared publishing path for its local publishing surface
- at least one read-first adoption path exists for `codev-app` or `ai-saas-starter-kit`
- CLI onboarding and docs exist
- shared compatibility fixtures are in place

At that point the workspace can move from “MCP rebaseline” to “MCP rollout execution.”
