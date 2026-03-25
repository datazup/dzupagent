# @forgeagent/otel Architecture

## Purpose
`@forgeagent/otel` connects ForgeAgent event streams to observability and governance primitives: tracing, metrics, cost attribution, safety monitoring, and tamper-evident auditing.

## Main Responsibilities
- Provide tracer abstraction with optional OpenTelemetry backends.
- Bridge Forge events to metrics/spans without impacting primary execution.
- Track and report cost/token attribution by agent/phase/tool.
- Detect safety threats in inputs/outputs (non-blocking monitor).
- Persist tamper-evident audit logs via hash-chained entries.
- Package observability setup as a plug-and-play Forge plugin.

## Module Structure
Top-level modules under `src/`:
- `tracer.ts`: Forge tracer wrappers and span lifecycle helpers.
- `trace-context-store.ts`: AsyncLocalStorage context propagation.
- `otel-bridge.ts`: event bus -> metrics/span mapping.
- `event-metric-map.ts`: canonical event-to-metric definitions.
- `cost-attribution.ts`: threshold-aware cost accounting.
- `safety-monitor.ts`: pattern-based safety event detection.
- `audit-trail.ts`: hash-chain audit store and verification logic.
- `otel-plugin.ts`: plugin factory that wires selected features.
- `noop.ts`, `otel-types.ts`, `span-attributes.ts`, `vector-metrics.ts`.

## How It Works
1. `createOTelPlugin()` receives feature toggles and optional config.
2. Plugin registers bridge/monitor/cost/audit handlers on Forge event bus.
3. Runtime events emit spans, metrics, and domain alerts.
4. Optional thresholds emit budget warnings/exceeded events.
5. Audit trail appends hash-linked entries for tamper detection.
6. If OTel SDKs are absent, noop implementations preserve API behavior.

## Main Features
- Optional dependency model with transparent noop fallback.
- Unified bridge from Forge domain events to telemetry outputs.
- Cost accounting and budget alerting.
- Safety threat signalization (prompt injection/tool misuse/exfiltration patterns).
- Tamper-evident auditing for post-incident traceability.

## Integration Boundaries
- Depends on `@forgeagent/core` event/plugin contracts.
- Integrates with any Forge runtime exposing an event bus.
- Optionally integrates with OTel SDK packages via peer dependencies.

## Extensibility Points
- Extend event-to-metric mapping.
- Add custom safety patterns and severity policies.
- Implement custom audit stores and retention controls.
- Add additional plugin presets for environment-specific instrumentation.

## Quality and Test Posture
- Tests cover bridge wiring, tracer behavior, cost attribution, safety detection, trace context, and audit chain integrity.
