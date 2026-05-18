# DzupAgent TODOs, Risks, and Improvement Plan

Date: 2026-05-17
Scope: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`
Mode: read-only source review plus documentation update. No runtime implementation was changed in this pass.

## Executive Summary

DzupAgent has strong governance for package tiers, public API drift, domain boundaries, security-audit status, terminal tool event correlation, and strict verification. The remaining work is not a single missing feature; it is a set of framework hardening and completion slices across remote memory transports, MCP transport behavior, plugin lifecycle, event semantics, observability retention, and maintenance-only server/playground drift.

Highest priority should stay on framework correctness and safe defaults, not product UX expansion. New product behavior still belongs in consuming apps first, especially `apps/codev-app`, unless a reusable primitive is explicitly needed by named consumers.

## Current Review Evidence

Repository guidance and validation surface:

- `AGENTS.md` defines DzupAgent as a Yarn workspace framework repo and explicitly keeps `packages/server` and `packages/playground` maintenance-only.
- Root scripts include `verify`, `verify:strict`, `check:domain-boundaries`, `check:package-tiers`, `check:server-api-surface`, `check:terminal-tool-event-guards`, `check:security-audit-status`, and package-scoped Turbo commands.
- Every package discovered under `packages/*` exposes `build`, `typecheck`, `test`, and `lint` scripts.
- CI includes `verify-strict`, security, coverage, connectors, orchestration race/cancel/contracts, compatibility matrix, and publish workflows.

Explicit live TODO/stub signals:

- `packages/memory/src/http-client.ts` exports `HttpMemoryClient`, but `get`, `put`, and `delete` all throw `NotImplementedError` while the wire protocol is still pending.
- `packages/memory-ipc/src/ipc-client.ts` supports an in-process backing service path, but endpoint-based remote IPC is intentionally unimplemented and throws `IpcNotConfiguredError`.
- `packages/core/src/mcp/ARCHITECTURE.md` documents that SSE discovery routes through HTTP semantics, stdio is request-spawn based instead of persistent session based, MCP reliability helpers are not wired automatically into `MCPClient`, and `InMemoryMcpManager` has no persistent backend.
- `packages/core/src/plugin/ARCHITECTURE.md` documents missing unload/dispose, shallow manifest validation, manifest-only discovery, duplicate name last-write-wins behavior, and an unused npm source enum.
- `packages/agent/src/tools/human-contact-tool.ts` documents user-profile preferred-channel resolution as not implemented in v1.
- `packages/server/docs/ARCHITECTURE.md` documents version drift in health output and source/export-map mismatch for `runtime.ts` and `compat.ts` facades.
- `packages/core/src/events/ARCHITECTURE.md` documents event bus dispatch documentation mismatch, large manually maintained `DzupEvent`, unsafe forwarding casts, swallowed event-log append failures, and scan-heavy agent bus history reads.
- `packages/otel/docs/ARCHITECTURE.md` documents version/documentation drift, in-memory retention growth, placeholder cost attribution, threshold-state coupling, and audit taxonomy gaps.
- Latest generated docs add three higher-signal gaps that should be tracked explicitly: flow-to-planning/team lowering is future-only, `AgentAuthConfig.requiredCapabilities` is not enforced by `AgentAuth`, and document connector chunk options/telemetry are incomplete.
- Latest dirty-tree hardening adds anchored gitleaks allowlist regexes plus `check:gitleaks-allowlist`; this should be validated and documented as a governance gate rather than treated as unrelated churn.

## Severity-Ranked Findings

### High: Remote Memory Transports Are Publicly Named But Not Implemented

Evidence:

- `packages/memory/src/http-client.ts` constructs an `HttpMemoryClient` but every CRUD method throws.
- `packages/memory-ipc/src/ipc-client.ts` supports only `backingService`; endpoint mode is explicitly reserved and throws.

Impact:

- Consumers can see remote-memory primitives and assume remote storage is available, but production use fails at runtime.
- Drift risk increases because `shared-kit/dzupagent-memory-kit` already validates store types such as `qdrant` and `redis`, while DzupAgent memory backend wiring remains incomplete.

Implementation plan:

1. Define a stable remote-memory protocol before writing transport code.
2. Add shared request/response schemas for `get`, `put`, `delete`, batch read, and health.
3. Implement `HttpMemoryClient` with injected `fetch`, timeout, abort, auth header, tenant scope validation, and clear error taxonomy.
4. Implement remote IPC endpoint mode only after the frame/protocol is documented; keep `backingService` as the in-process path.
5. Add contract tests that run the same CRUD suite against in-memory, HTTP mock, and IPC backing-service implementations.

Validation:

- `yarn workspace @dzupagent/memory test`
- `yarn workspace @dzupagent/memory-ipc test`
- `yarn workspace @dzupagent/agent-types typecheck`
- `yarn check:domain-boundaries`
- `yarn check:package-tiers`

### High: MCP Transport Semantics Are Incomplete For Production-Grade Use

Evidence:

- MCP docs state stdio is request-spawn based per operation, SSE routes through HTTP discovery, reliability/pool helpers are standalone, and manager persistence is in-memory only.

Impact:

- High-volume MCP use can pay process-spawn overhead per call.
- Consumers expecting actual SSE stream semantics may get polling/request semantics instead.
- Reliability helpers exist but are opt-in, so deployments can accidentally run without pooling/circuit/cache behavior.

Implementation plan:

1. Add an MCP transport capability matrix: HTTP, SSE, stdio request-spawn, stdio persistent-session.
2. Split current behavior into explicitly named transports so consumers cannot confuse request-spawn stdio with session stdio.
3. Implement persistent stdio sessions with lifecycle, heartbeat, cancellation, exit-code propagation, and bounded output buffers.
4. Implement real SSE stream handling or mark SSE discovery unsupported until implemented.
5. Add an optional default `McpReliabilityManager`/connection-pool adapter in `MCPClient` config while preserving manual composition.
6. Add a persistent manager interface and keep `InMemoryMcpManager` clearly test/local only.

Validation:

- `yarn workspace @dzupagent/core test src/mcp`
- `yarn workspace @dzupagent/core typecheck`
- `yarn check:terminal-tool-event-guards`
- `yarn check:domain-boundaries`

### High: Plugin Lifecycle And Manifest Validation Are Too Shallow For Dynamic Plugins

Evidence:

- Plugin architecture notes document no unload/dispose path, shallow manifest validation, manifest-only discovery, duplicate plugin names overwriting in `Map`, and an unused npm discovery source.

Impact:

- Event subscriptions can leak after plugin replacement or test teardown.
- Bad manifests can pass discovery and fail later.
- Duplicate plugin names can silently shadow earlier definitions.

Implementation plan:

1. Add strict manifest schema validation: semver, entry-point path safety, expected array item types, supported source values.
2. Change duplicate plugin names from last-write-wins to explicit conflict diagnostics.
3. Track event subscription disposers and add `unregisterPlugin` / `disposePlugin` lifecycle APIs.
4. Decide whether runtime module import belongs in core plugin discovery; if yes, implement a safe loader with allowlisted roots and ESM error taxonomy; if no, remove or rename the `entryPoint` contract to avoid false promise.
5. Add tests for duplicate manifests, invalid entry points, unload event unsubscription, and npm-source behavior.

Validation:

- `yarn workspace @dzupagent/core test src/__tests__/plugin* src/plugin`
- `yarn workspace @dzupagent/core typecheck`
- `yarn check:domain-boundaries`

### Medium-High: Event And Observability Contracts Need Drift Reduction

Evidence:

- Event docs note inline handler invocation despite comments describing microtask dispatch.
- `DzupEvent` is manually expanded across files.
- Registry forwarding uses `event as DzupEvent`.
- `EventLogSink.attach()` fire-and-forget appends and swallows failures.
- OTEL docs note unbounded in-memory metric samples, default in-memory audit retention, placeholder cost attribution, threshold-state coupling, and unmapped audit categories.

Impact:

- Event payload drift becomes hard to detect as packages add new events.
- Operators can miss event-log persistence failures.
- Long-lived processes can accumulate observability memory.
- Cost/audit telemetry can look present but not accurate enough for production billing/governance.

Implementation plan:

1. Introduce a generated or centrally typed event registry and derive `DzupEvent` from it.
2. Replace unchecked event forwarding casts with typed adapter functions.
3. Update event-bus docs/comments to match inline dispatch behavior, or change implementation if async dispatch is intended.
4. Add optional `EventLogSink` failure callback or error event so append failures are observable without breaking producers by default.
5. Add retention limits to in-memory metric/audit sinks and expose pruning configuration.
6. Wire real token/cost usage sources into `CostAttributor.record()` instead of zero-cost placeholders.
7. Split cost-threshold and token-threshold warning state.
8. Map `safety_event` and `config_change` audit categories or remove unsupported categories from public expectation.

Validation:

- `yarn workspace @dzupagent/core test src/__tests__/*event*`
- `yarn workspace @dzupagent/otel test`
- `yarn workspace @dzupagent/core typecheck`
- `yarn check:package-export-artifacts`

### Medium: Human-Contact Channel Resolution Is Incomplete

Evidence:

- `packages/agent/src/tools/human-contact-tool.ts` documents a four-step channel resolution order but skips user-profile preferred-channel lookup in v1.

Impact:

- Human-in-the-loop behavior may ignore user preference even though the design says preference is part of routing.
- Integrations may build app-local workarounds that later conflict with the framework contract.

Implementation plan:

1. Define a narrow `HumanContactPreferenceResolver` interface rather than baking app user models into the framework.
2. Add optional resolver injection at agent/run configuration boundaries.
3. Preserve explicit channel override and agent default behavior.
4. Add tests for explicit, profile-preferred, agent-default, and fallback resolution.

Validation:

- `yarn workspace @dzupagent/agent test src/tools`
- `yarn workspace @dzupagent/core test src/tools`
- `yarn workspace @dzupagent/agent typecheck`

### Medium: Server/Playground Maintenance Surfaces Still Carry Drift

Evidence:

- Server architecture docs report health version drift and unexported `runtime.ts` / `compat.ts` facades.
- Playground docs are decommission-oriented and include TODOs to keep root/server docs aligned if a dedicated UI package is reintroduced.

Impact:

- Compatibility consumers may see inconsistent version data.
- Source facades that are not exported can mislead maintainers and produce undocumented import paths.

Implementation plan:

1. Fix health/version source to use the same constant as package metadata.
2. Decide whether `runtime` and `compat` are supported subpaths. Either export them and add public API allowlist entries, or mark them internal/remove misleading docs.
3. Keep `packages/playground` maintenance-only and do not add new product UI behavior there.

Validation:

- `yarn workspace @dzupagent/server test`
- `yarn workspace @dzupagent/server typecheck`
- `yarn check:server-api-surface`
- `yarn check:package-tiers`

### Low-Medium: Large Barrel And Hotspot Files Increase Review Cost

Evidence:

- Largest non-test production files include `packages/core/src/index.ts`, `packages/agent-adapters/src/registry/registry-router.ts`, `packages/agent/src/index.ts`, `packages/agent-adapters/src/index.ts`, `packages/flow-compiler/src/index.ts`, and several self-correction, connector, MCP, and server persistence modules.

Impact:

- Some large files are legitimate public barrels, but broad files concentrate API drift and make targeted review harder.

Implementation plan:

1. Do not refactor barrels just for line count.
2. For runtime hotspots, extract only stable internal seams when a test can prove behavior parity.
3. Add package-local architecture docs when a split creates new ownership boundaries.

Validation:

- Package-scoped `test`, `typecheck`, and `build` for each touched package.
- `yarn check:package-export-artifacts` for barrel/export changes.

## Implementation Packets

### P0: Rebaseline Before Code Changes

Goal: avoid stale-plan implementation.

Tasks:

1. Re-run focused TODO/risk scans excluding docs/tests to confirm no new explicit stubs.
2. Run fast governance checks before touching code.
3. Confirm current dirty files and avoid overwriting existing documentation changes.

Commands:

```bash
git status --short
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/.turbo/**' --glob '!**/.git/**' "TODO|FIXME|XXX|HACK|not implemented|NotImplemented" packages --glob '!**/*.test.ts' --glob '!**/__tests__/**'
yarn check:security-audit-status
yarn check:package-tiers
yarn check:domain-boundaries
yarn check:server-api-surface
yarn check:terminal-tool-event-guards
```

Exit criteria:

- Baseline failures are documented as either current-slice blockers or unrelated existing drift.

### P1: Memory Transport Contract Completion

Owner packages: `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/agent-types`.

Tasks:

1. Write protocol contract docs and shared test matrix.
2. Implement `HttpMemoryClient` CRUD with strict scope validation and error taxonomy.
3. Add remote IPC protocol decision note; implement only if wire format is stable.
4. Align `shared-kit/dzupagent-memory-kit` supported store messaging after DzupAgent backend support is real.

Validation:

```bash
yarn workspace @dzupagent/memory test
yarn workspace @dzupagent/memory-ipc test
yarn workspace @dzupagent/agent-types typecheck
yarn check:domain-boundaries
```

### P2: MCP Transport And Reliability Wiring

Owner packages: `@dzupagent/core`, possibly `@dzupagent/test-utils` for fixtures.

Tasks:

1. Rename/mark current stdio request-spawn transport explicitly.
2. Add persistent stdio session transport or document unsupported status as a hard error.
3. Implement real SSE semantics or reject SSE with a typed unsupported error.
4. Add optional reliability/pool composition in `MCPClient` config.
5. Add persistent manager interface without forcing a database implementation into core.

Validation:

```bash
yarn workspace @dzupagent/core test src/mcp
yarn workspace @dzupagent/core typecheck
yarn check:terminal-tool-event-guards
yarn check:domain-boundaries
```

### P3: Plugin Lifecycle Hardening

Owner package: `@dzupagent/core`.

Tasks:

1. Add strict manifest parser.
2. Fail on duplicate plugin names with actionable diagnostics.
3. Track and dispose event subscriptions.
4. Decide and implement/decline safe `entryPoint` loading.

Validation:

```bash
yarn workspace @dzupagent/core test src/__tests__/plugin-mcp-deep.test.ts
yarn workspace @dzupagent/core typecheck
yarn check:domain-boundaries
```

### P4: Event/OTEL Drift Reduction

Owner packages: `@dzupagent/core`, `@dzupagent/otel`.

Tasks:

1. Centralize event contract definitions and reduce casts.
2. Add event-log append failure observability.
3. Add in-memory retention controls.
4. Replace placeholder cost attribution with real usage-source integration.
5. Complete audit category mapping.

Validation:

```bash
yarn workspace @dzupagent/core test
yarn workspace @dzupagent/otel test
yarn workspace @dzupagent/otel typecheck
yarn check:package-export-artifacts
```

### P5: Server Maintenance Drift Cleanup

Owner package: `@dzupagent/server`.

Tasks:

1. Fix health version constant.
2. Decide/export or internalize `runtime` and `compat` facades.
3. Update server API surface docs.

Validation:

```bash
yarn workspace @dzupagent/server test
yarn workspace @dzupagent/server typecheck
yarn check:server-api-surface
yarn check:package-tiers
```

### P6: Human Contact Preference Resolver

Owner packages: `@dzupagent/agent`, `@dzupagent/core`.

Tasks:

1. Add optional resolver contract.
2. Wire channel resolution order without importing app user models.
3. Add regression tests for all resolution branches.

Validation:

```bash
yarn workspace @dzupagent/agent test src/tools
yarn workspace @dzupagent/agent typecheck
yarn workspace @dzupagent/core typecheck
```

## Release/Verification Strategy

Use this order:

1. Package-local test/typecheck for the touched package.
2. Adjacent package checks when public types or exports change.
3. Governance checks: `check:domain-boundaries`, `check:package-tiers`, `check:package-export-artifacts`.
4. Full `yarn verify` for cross-package code changes.
5. `yarn verify:strict` only after package-level and governance checks are green, because it is broader and can surface unrelated stale build churn.

## Do Not Do

- Do not add product UX or app workflow behavior to `packages/server` or `packages/playground`.
- Do not implement remote transports without a documented protocol and contract tests.
- Do not widen root exports to make tests pass; update package tier/allowlist policy only when the public contract is intentional.
- Do not collapse all architecture TODOs into one refactor. Each packet above should be reviewable independently.

## Next Recommended First Slice

Start with P1, `HttpMemoryClient` contract completion, because it is an explicit runtime stub with a small package boundary and clear contract-test path. If the current priority is MCP interoperability instead, start P2 but keep it limited to transport semantics and tests, not broader MCP product features.

## Detailed Implementation Pack

This summary is expanded into a multi-document implementation pack at:

- `docs/planning/todos-risks-implementation-2026-05-17/README.md`
- `docs/planning/todos-risks-implementation-2026-05-17/01-gap-analysis.md`
- `docs/planning/todos-risks-implementation-2026-05-17/02-feature-and-architecture-decisions.md`
- `docs/planning/todos-risks-implementation-2026-05-17/03-implementation-roadmap.md`
- `docs/planning/todos-risks-implementation-2026-05-17/04-validation-and-closeout.md`
- `docs/planning/todos-risks-implementation-2026-05-17/05-feature-catalog.md`
- `docs/planning/todos-risks-implementation-2026-05-17/06-architecture-change-inventory.md`
- `docs/planning/todos-risks-implementation-2026-05-17/07-gap-detail-sheets.md`
