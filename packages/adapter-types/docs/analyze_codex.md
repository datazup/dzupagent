# `@dzupagent/adapter-types` Analysis and Gap Assessment

Date: 2026-04-03  
Scope: `packages/adapter-types` (with cross-package contract validation against `packages/agent-adapters`)

## Executive Summary

`@dzupagent/adapter-types` is a clean, focused package that successfully centralizes adapter contracts and keeps a zero-runtime-dependency footprint. Local quality gates for this package passed (`build`, `typecheck`, `test`), and the broader consumer package (`@dzupagent/agent-adapters`) also typechecks and passes targeted contract-heavy tests.

Main issue: the contract currently models provider IDs as a closed enum-like union while the runtime architecture supports dynamic plugin providers and unknown fallback states. This mismatch is forcing repeated unsafe casts in core orchestration paths and tests, reducing the practical value of the type guarantees.

## Method and Validation

Reviewed files:
- `packages/adapter-types/src/index.ts`
- `packages/adapter-types/src/__tests__/adapter-types.test.ts`
- `packages/adapter-types/src/__tests__/adapter-types.integration.test.ts`
- `packages/adapter-types/package.json`
- `packages/adapter-types/tsconfig.json`
- `packages/adapter-types/tsup.config.ts`

Cross-package contract checks:
- `packages/agent-adapters/src/types.ts`
- `packages/agent-adapters/src/plugin/adapter-plugin-sdk.ts`
- `packages/agent-adapters/src/registry/adapter-registry.ts`
- `packages/agent-adapters/src/recovery/adapter-recovery.ts`
- `packages/agent-adapters/src/http/adapter-http-handler.ts`
- `packages/agent-adapters/src/facade/orchestrator-facade.ts`
- `packages/agent-adapters/src/codex/codex-adapter.ts`

Commands executed:
- `yarn workspace @dzupagent/adapter-types build` ✅
- `yarn workspace @dzupagent/adapter-types typecheck` ✅
- `yarn workspace @dzupagent/adapter-types test` ✅
- `yarn workspace @dzupagent/agent-adapters typecheck` ✅
- `yarn workspace @dzupagent/agent-adapters test -- src/__tests__/adapter-plugin.test.ts` ✅
- `yarn workspace @dzupagent/agent-adapters test -- src/__tests__/adapter-http-handler.test.ts` ✅

Note: the `analyze` skill referenced a baseline script path that does not exist in this environment (`/home/ninel/.codex/skills/analyze/scripts`), so the assessment is based on direct static review + targeted test execution.

## Current Implementation Snapshot

### Package design quality

- Single source of truth for core adapter contracts (`src/index.ts`) with no transitive runtime dependency burden.
- Strong discriminated union for `AgentEvent`.
- Good separation: `@dzupagent/agent-adapters` re-exports these types for compatibility (`packages/agent-adapters/src/types.ts:5`).
- Build config is minimal and appropriate for a type-centric package (`tsup` ESM + DTS).

### Coverage and tests

- Existing tests validate runtime shape examples and union exhaustiveness behavior in a switch.
- Tests are mostly sample-object conformance tests; there are no compile-only contract regression tests (e.g., tsd) for consumer-facing type behavior.

## Findings (Severity Ordered)

## High

### 1) Provider ID type is closed, but runtime is extensible

Domain: Architecture / Type-safety  
Severity: High

Summary:
`AdapterProviderId` is defined as a closed union:
- `packages/adapter-types/src/index.ts:10`

But runtime systems support:
- Third-party plugin IDs as arbitrary strings (`packages/agent-adapters/src/plugin/adapter-plugin-sdk.ts:9`)
- Unknown fallback providers, currently forced via casts:
  - `packages/agent-adapters/src/recovery/adapter-recovery.ts:165`
  - `packages/agent-adapters/src/http/adapter-http-handler.ts:246`
  - `packages/agent-adapters/src/facade/orchestrator-facade.ts:84`

Impact:
- Repeated `as AdapterProviderId` casts reduce static safety and hide invalid states.
- Plugin extensibility is nominally supported, but type contracts resist it.
- Routing/telemetry code must manually coerce invalid sentinel values (`'unknown'`) into the provider type.

Recommendation:
- Split provider IDs into:
  - `BuiltinAdapterProviderId` (closed union)
  - `AdapterProviderId = BuiltinAdapterProviderId | (string & {})`
- Add helper guards:
  - `isBuiltinAdapterProviderId(id: string): id is BuiltinAdapterProviderId`
- Replace `'unknown' as AdapterProviderId` fallback with explicit nullable provider fields where the provider truly cannot be resolved.

---

## Medium

### 2) Tool call/result contracts lack correlation identifiers

Domain: Observability / API correctness  
Severity: Medium

Summary:
`AgentToolCallEvent` and `AgentToolResultEvent` contain `toolName` but no stable correlation key:
- `packages/adapter-types/src/index.ts:85-104`

In adapters, multiple tool calls/results with same `toolName` can occur:
- `packages/agent-adapters/src/codex/codex-adapter.ts:556-625`

Impact:
- Hard to pair tool calls with results in concurrent or repeated-tool scenarios.
- Limits precise tracing, metrics, and debugging in streaming pipelines.

Recommendation:
- Extend schema with optional IDs:
  - `toolCallId?: string` on `adapter:tool_call`
  - `toolCallId?: string` and `status?: 'ok' | 'error'` on `adapter:tool_result`
- Add event-level unique ID (`eventId`) + causal link (`parentEventId`) for general correlation.

---

### 3) Error contract is too stringly typed for consistent downstream behavior

Domain: Quality / Operability  
Severity: Medium

Summary:
`AgentFailedEvent.code` is `string | undefined`:
- `packages/adapter-types/src/index.ts:118-127`

Downstream mapping collapses most failures to a generic code:
- `packages/agent-adapters/src/registry/event-bus-bridge.ts:104`

Impact:
- Loss of error semantics (timeout vs auth vs budget vs provider-specific).
- Consumers cannot build robust policy decisions or analytics on stable code families.

Recommendation:
- Introduce typed failure taxonomy:
  - `AdapterFailureCode` union for framework-level failures
  - `providerCode?: string` for raw provider code
  - `category?: 'cancelled' | 'timeout' | 'dependency' | 'provider' | 'validation' | 'budget' | 'internal'`
- Keep backward compatibility by preserving `code` short-term and marking migration path.

---

### 4) Unknown provider fallback is modeled as a fake provider, not an explicit unresolved state

Domain: Architecture / Data quality  
Severity: Medium

Summary:
When provider cannot be resolved, code injects `'unknown'` cast into `AdapterProviderId`:
- `packages/agent-adapters/src/recovery/adapter-recovery.ts:165`
- `packages/agent-adapters/src/recovery/adapter-recovery.ts:658`
- `packages/agent-adapters/src/output/structured-output.ts:282`

Impact:
- Telemetry and business logic may treat `"unknown"` as a real provider.
- Type system cannot distinguish “known provider” from “unresolved provider”.

Recommendation:
- Add explicit unresolved modeling:
  - `providerId?: AdapterProviderId`
  - `providerResolution?: 'resolved' | 'unresolved'`
  - optional `providerResolutionReason?: string`
- Avoid fake sentinel values where absence is semantically correct.

---

### 5) `resumeSession` is mandatory despite capability-based support model

Domain: API ergonomics  
Severity: Medium

Summary:
`AgentCLIAdapter.resumeSession` is required:
- `packages/adapter-types/src/index.ts:246`

Yet capability system already exposes resume support:
- `packages/adapter-types/src/index.ts:14` (`supportsResume`)

Mock/utility adapters frequently implement no-op resume methods just to satisfy interface:
- `packages/agent-adapters/src/__tests__/workflow-timeout.test.ts:40-42`

Impact:
- Boilerplate in adapters that do not support resume.
- Contract sends mixed signals: “unsupported” is both capability flag and mandatory method.

Recommendation:
- Make `resumeSession` optional and rely on capability contract (`supportsResume`) for discovery.
- Alternative: keep required but provide a shared base default implementation in a core abstract adapter (if runtime package wants strict method presence).

---

## Low

### 6) Type package lacks dedicated consumer-facing docs and compile-time contract tests

Domain: Maintainability / Developer experience  
Severity: Low

Summary:
- No package-level README in `packages/adapter-types`.
- Tests focus on sample runtime objects rather than compile-time compatibility constraints.

Impact:
- External adapter authors lack a concise contract reference and migration notes.
- Regressions in subtle type behavior are harder to catch early.

Recommendation:
- Add `packages/adapter-types/README.md` with:
  - minimal adapter implementation example
  - event lifecycle diagram
  - capability semantics
- Add compile-time tests (e.g., `tsd` or constrained type-check fixtures) for:
  - discriminated union narrowing
  - plugin provider ID typing
  - optional vs required event fields

## Strengths

- Minimal scope and clean public surface area.
- Strong discriminated event union with clear event names.
- Correlation ID is consistently included across event shapes and input.
- Build output remains tiny and focused (`dist/index.js` is effectively empty runtime wrapper + DTS payload).

## Feature Proposals

### Near-term (1-2 sprints)

1. Provider ID extensibility model (builtin + custom string IDs).
2. Tool event correlation fields (`toolCallId`) and optional `eventId`.
3. Error taxonomy additions (`category`, `providerCode`) while preserving legacy `code`.
4. README + type-level contract tests for external adapter developers.

### Mid-term (2-4 sprints)

1. Event envelope versioning:
   - add `schemaVersion` or `contractVersion` to events.
2. Rich capability negotiation:
   - move from booleans-only to structured capability descriptors with limits/modes.
3. JSON-safe shared primitives:
   - consider `EpochMs` for serialized boundaries where `Date` objects cross process/network.

### Long-term

1. Formal adapter conformance kit:
   - reusable contract test harness that third-party adapters can run.
2. Compatibility policy and deprecation framework:
   - semver-level guarantees per type segment (core events vs optional extensions).

## Suggested Migration Strategy

1. Introduce additive fields/types first (no breaking changes).
2. Publish helper guards/utilities in `@dzupagent/adapter-types`.
3. Update `@dzupagent/agent-adapters` internals to remove unsafe casts.
4. Add deprecation notices for legacy-only patterns (`unknown` sentinel casts, untyped error codes).
5. Remove or tighten deprecated patterns in next major version.

## Open Questions

1. Should third-party providers be first-class in routing/cost modules, or intentionally “opaque custom providers” with reduced orchestration features?
2. Is `providerId` required for all terminal events, or can unresolved provider states be acceptable when failures happen before adapter selection?
3. Should progress events be bridgeable to core event bus in a backward-compatible optional channel?

## Final Assessment

The package is structurally sound and production-usable, but there is a clear type-contract drift between “closed known providers” and “runtime-extensible providers.” Addressing this single architectural mismatch (plus event correlation and error taxonomy upgrades) will materially improve safety, observability, and plugin developer experience without destabilizing current consumers.
