# `@dzupagent/otel` Implementation Analysis and Gap Assessment

Date: 2026-04-03  
Scope: `packages/otel` (source, tests, docs, package-level quality gates)

## Executive Summary

`@dzupagent/otel` has strong test breadth and a clean modular split for tracing, metrics bridging, cost attribution, safety monitoring, and audit logging. The package is functionally rich, but there are critical gaps between implementation and operational readiness:

- `build`/`typecheck` are currently broken due to event-schema drift with `@dzupagent/core`.
- Several modules have documentation-vs-runtime mismatches (especially `DzupTracer`, `SafetyMonitor`, and `AuditTrail`).
- Reliability/observability blind spots exist where instrumentation failures are swallowed silently.
- Cost attribution and safety monitoring are mostly local/in-memory and not yet deeply integrated with richer runtime signals already present in `core`.

Overall posture: good foundations, incomplete production hardening.

## What Was Reviewed

- Runtime modules:
  - `tracer.ts`, `trace-context-store.ts`, `otel-bridge.ts`, `event-metric-map*.ts`
  - `cost-attribution.ts`, `safety-monitor.ts`, `audit-trail.ts`, `otel-plugin.ts`
- Public surface:
  - `index.ts`, `README.md`, `docs/ARCHITECTURE.md`
- Validation:
  - `yarn workspace @dzupagent/otel test` (pass)
  - `yarn workspace @dzupagent/otel lint` (pass)
  - `yarn workspace @dzupagent/otel typecheck` (fail)
  - `yarn workspace @dzupagent/otel build` (fail during DTS)

## Current Implementation Snapshot

### Strengths

- Broad test suite with meaningful coverage depth: 18 test files / 515 tests passed.
- Good package decomposition and clear responsibilities per module.
- Strong compile-time approach in event metric mapping via `satisfies Record<DzupEvent['type'], MetricMapping[]>` ([packages/otel/src/event-metric-map.ts:54](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/event-metric-map.ts:54)).
- Optional peer dependency model with noop fallback is well designed for incremental adoption.

### Architectural Notes

- `OTelBridge` is the central event-to-metric/spans adapter.
- Metric mapping is fragment-based and composes cleanly.
- Audit trail provides tamper-evident chain semantics, but mostly as an in-memory implementation today.
- Plugin factory enables coarse feature toggles, but runtime lifecycle/cleanup ergonomics are minimal.

## Findings (Ordered by Severity)

## Critical

1. Event schema drift currently breaks `typecheck` and `build`
- Impact: package cannot produce valid DTS artifacts; CI/release stability risk.
- Evidence:
  - Core introduced `system:degraded` event ([packages/core/src/events/event-types.ts:138](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/events/event-types.ts:138)).
  - `EVENT_METRIC_MAP` lacks this key and fails `Record<DzupEvent['type'], ...>` completeness ([packages/otel/src/event-metric-map.ts:54](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/event-metric-map.ts:54)).
  - Related index access type error in bridge ([packages/otel/src/otel-bridge.ts:202](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/otel-bridge.ts:202)).
- Recommendation:
  - Add `system:degraded` mapping (likely empty or explicit counter) and enforce cross-package event parity in CI.
  - Add a focused test asserting all `DzupEvent['type']` keys are present in `EVENT_METRIC_MAP`.

## High

2. Silent failure policy in bridge hides instrumentation outages
- Impact: telemetry pipeline can fail silently in production with no signal to operators.
- Evidence: all bridge handler exceptions are swallowed intentionally with no fallback reporting ([packages/otel/src/otel-bridge.ts:163](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/otel-bridge.ts:163), [packages/otel/src/otel-bridge.ts:167](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/otel-bridge.ts:167)).
- Recommendation:
  - Keep non-fatal behavior, but emit internal health counter/log/hook (`otel_bridge_errors_total`) and optional debug logger callback.

3. Cost attribution does not capture real cost by default and uses synthetic zero-value records
- Impact: reports look populated but can be operationally misleading.
- Evidence:
  - `agent:completed` and `tool:result` handlers write `costCents: 0`, `tokens: 0` ([packages/otel/src/cost-attribution.ts:119](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:119), [packages/otel/src/cost-attribution.ts:129](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:129)).
  - Tool records assign `agentId: '__unknown__'` ([packages/otel/src/cost-attribution.ts:131](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:131)).
- Recommendation:
  - Integrate with real LLM/tool usage sources (or core middleware outputs) and avoid synthetic rows unless explicitly marked as placeholders.

4. Threshold signaling conflates token/cost channels
- Impact: warning/exceeded events for one dimension can suppress the other.
- Evidence:
  - Shared booleans for both channels: `_warningEmitted`, `_exceededEmitted` ([packages/otel/src/cost-attribution.ts:98](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:98), [packages/otel/src/cost-attribution.ts:99](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:99)).
  - Reused in both cost and token branches ([packages/otel/src/cost-attribution.ts:229](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:229), [packages/otel/src/cost-attribution.ts:249](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:249)).
- Recommendation:
  - Track emitted state per dimension (`cost`, `tokens`) independently.

5. Safety monitor behavior diverges from its own contract
- Impact: false confidence that output scanning and alert emission are active.
- Evidence:
  - Comment says `tool:result` is used to scan output, but implementation only resets counters ([packages/otel/src/safety-monitor.ts:148](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/safety-monitor.ts:148), [packages/otel/src/safety-monitor.ts:174](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/safety-monitor.ts:174)).
  - Top-level doc says “optionally emits alerts”, but no bus emission exists in class ([packages/otel/src/safety-monitor.ts:6](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/safety-monitor.ts:6)).
- Recommendation:
  - Either implement emission/output scan path or tighten docs/API semantics to match actual behavior.

## Medium

6. In-memory histogram storage is unbounded
- Impact: long-lived processes risk memory growth.
- Evidence: histogram values are appended forever in arrays ([packages/otel/src/otel-bridge.ts:50](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/otel-bridge.ts:50), [packages/otel/src/otel-bridge.ts:58](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/otel-bridge.ts:58)).
- Recommendation:
  - Add bounded reservoir sampling/windowing or exporter-only aggregation mode.

7. Audit category model is richer than active event mapping
- Impact: declared domains (`safety_event`, `config_change`) are unreachable, reducing audit completeness.
- Evidence:
  - Categories declared ([packages/otel/src/audit-trail.ts:33](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/audit-trail.ts:33), [packages/otel/src/audit-trail.ts:35](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/audit-trail.ts:35)).
  - `mapEvent` has no corresponding cases ([packages/otel/src/audit-trail.ts:145](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/audit-trail.ts:145)).
- Recommendation:
  - Map at least `safety:*`, `policy:*`, `system:degraded`, and selected config-changing events.

8. Fire-and-forget audit append may lose records during abrupt shutdown
- Impact: integrity chain can be incomplete under process termination/load spikes.
- Evidence: append is intentionally unawaited ([packages/otel/src/audit-trail.ts:270](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/audit-trail.ts:270)).
- Recommendation:
  - Add optional flush API / backpressure strategy for durable stores.

9. `DzupTracer` docs describe callback/context behavior not present in API
- Impact: API consumers can implement wrong calling patterns.
- Evidence:
  - Class comment claims callback lifecycle and context wrapping ([packages/otel/src/tracer.ts:54](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/tracer.ts:54)).
  - Public methods only return spans and do not wrap callbacks/context.
- Recommendation:
  - Add `withSpan(...)`/`runInSpan(...)` helpers or correct docs to current behavior.

10. Usage percentage model mixes incomparable limits into `iterationsLimit`
- Impact: reported budget usage semantics are confusing.
- Evidence: `iterationsLimit` derives from `Math.max(maxCostCents, maxTokens, 1)` ([packages/otel/src/cost-attribution.ts:270](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/cost-attribution.ts:270)).
- Recommendation:
  - Use explicit iteration threshold config or remove derived `iterationsLimit` from usage payload.

## Low

11. `verifyChain` comment promises loading entries when omitted, but implementation does not
- Impact: minor API expectation mismatch.
- Evidence:
  - Comment ([packages/otel/src/audit-trail.ts:333](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/audit-trail.ts:333)).
  - Method returns valid for undefined/empty input ([packages/otel/src/audit-trail.ts:336](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/audit-trail.ts:336)).
- Recommendation:
  - Adjust docs or add `verifyChainFromStore()` async helper.

12. `otel-plugin.ts` ends with orphaned utility comment (incomplete API affordance)
- Impact: small maintainability signal; suggests intended but missing introspection utility.
- Evidence: trailing comment block with no implementation ([packages/otel/src/otel-plugin.ts:130](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/otel/src/otel-plugin.ts:130)).
- Recommendation:
  - Remove stale comment or implement explicit accessor utility.

## Gap Analysis Matrix

| Domain | Current State | Gap | Priority |
|---|---|---|---|
| Quality | Strong tests, modular design | Type/schema drift breaks compile; doc-runtime mismatches | P0 |
| Reliability | Non-fatal instrumentation model | Silent catch paths with no health signals | P1 |
| Performance | Efficient event mapping | Unbounded in-memory histogram/audit growth patterns | P1 |
| Security/Governance | Safety and audit primitives exist | Safety output scanning not implemented; audit coverage incomplete for security/system events | P1 |
| Architecture | Clean compositional metric-map fragments | Duplication/divergence with richer `core` cost attribution model | P1 |
| Operability | Good local inspection APIs | Missing flush/lifecycle controls and bridge health telemetry | P2 |

## Proposed New Features

### P0: Event Schema Guardrail and Drift Prevention

- Feature: `event-schema-compat` test utility in `@dzupagent/otel` that asserts full key parity with `DzupEvent['type']`.
- Why: prevent regressions like missing `system:degraded` mapping.
- Deliverables:
  - New completeness test.
  - Required empty mapping for intentionally ignored events.

### P1: Observability Health Channel

- Feature: internal health metrics/logging for bridge/audit/safety failures.
- Why: keep non-fatal instrumentation while restoring debuggability.
- Deliverables:
  - `otel_bridge_errors_total`, `audit_append_failures_total`, `safety_scan_failures_total`.
  - Optional `onInstrumentationError` callback in plugin config.

### P1: Cost Attribution V2 (Real Usage Integration)

- Feature: ingest real token/cost data from runtime usage events/middleware, with dimension-specific threshold state.
- Why: current reports can be placeholder-heavy and suppress one threshold channel.
- Deliverables:
  - Distinct warning/exceeded state per budget dimension.
  - Optional model/run buckets (align with `core` cost collector model).

### P1: Safety Monitor V2

- Feature: explicit `scanOutput` integration path plus optional event-bus emission (`safety:violation`) from this module.
- Why: close current contract gap and enable alerting pipelines.
- Deliverables:
  - Configurable output extraction strategy.
  - Optional dedupe/rate-limit for repetitive tool misuse alerts.

### P1: Audit Coverage Expansion

- Feature: map `safety:*`, `policy:*`, and `system:degraded` to audit categories.
- Why: align declared categories with actual recorded coverage.
- Deliverables:
  - New mappings and tests.
  - Configurable per-category redaction hooks for sensitive fields.

### P2: Durable Export/Flush Lifecycle

- Feature: `flush()` / `shutdown()` contract for `OTelBridge` and `AuditTrail`.
- Why: reduce data loss on shutdown and support durable backends.
- Deliverables:
  - Async teardown API.
  - Plugin helper to coordinate flush order.

### P2: Memory-Safe Metric Sink Modes

- Feature: bounded histogram mode (reservoir, HDR histogram, or fixed-window summary).
- Why: avoid unbounded memory in long-running agents.
- Deliverables:
  - `InMemoryMetricSink` strategy config (`raw`, `windowed`, `reservoir`).

## Recommended Remediation Roadmap

1. Immediate (P0)
- Add `system:degraded` mapping and restore `typecheck`/`build`.
- Add schema parity test for event map completeness.

2. Short-term (P1)
- Implement instrumentation health reporting.
- Upgrade cost and safety modules to align behavior with contract and runtime data.
- Expand audit mapping coverage for security/degraded events.

3. Mid-term (P2)
- Introduce flush lifecycle + bounded metric storage strategies.
- Reconcile/align cost-attribution architecture with `packages/core/src/middleware/cost-attribution.ts` to avoid divergence.

## Validation Checklist After Fixes

- `yarn workspace @dzupagent/otel build`
- `yarn workspace @dzupagent/otel typecheck`
- `yarn workspace @dzupagent/otel lint`
- `yarn workspace @dzupagent/otel test`
- Add regression tests for:
  - event-map completeness for all `DzupEvent` keys
  - dual-threshold signaling behavior (cost + token)
  - safety output scanning path
  - audit mapping for `system:degraded` and `safety:*`

## Command Outcome Summary

- `test`: pass (18 files, 515 tests).
- `lint`: pass.
- `typecheck`: fail (missing `system:degraded` metric mapping).
- `build`: JS bundle succeeds, DTS step fails for same type completeness issue.
