# DzupAgent Detailed Gap Sheets

Date: 2026-05-17
Purpose: provide implementation-level analysis for each high and medium-high gap.

## DZ-GAP-001: Remote Memory Is Named But Not Implemented

### Current Evidence

- `HttpMemoryClient` validates `baseUrl` then throws `NotImplementedError` for `get`, `put`, and `delete`.
- `IpcMemoryClient` endpoint mode throws unless `backingService` is supplied.
- Public docs and capability matrix surface `HttpMemoryClient`, creating visibility beyond an internal TODO.

### Why This Matters

Remote memory is a framework-level persistence primitive. A configured but nonfunctional client can cause runtime failures in consumers that expect HTTP memory to work. Because shared-kit memory helpers also talk about backend types, this risk crosses repo boundaries.

### Implementation Notes

- Start with HTTP because it can be contract-tested without defining an Arrow IPC frame format.
- Create a single contract suite that all memory clients must satisfy.
- Avoid app-specific tenancy semantics; only validate that required `MemoryScope` fields are present and serialized correctly.

### Tests To Add

- CRUD success with mocked fetch.
- Auth header is sent only when configured.
- Timeout/abort maps to typed error.
- Server 4xx/5xx maps to typed error and does not silently return empty data.
- Scope fields are serialized and invalid scope fails early.

## DZ-GAP-002: MCP Transport Semantics Are Ambiguous

### Current Evidence

- MCP architecture docs say stdio transport request-spawns per operation.
- SSE discovery routes through HTTP behavior.
- Reliability and pool helpers are standalone, not automatically composed.
- Manager persistence is in-memory only.

### Why This Matters

MCP is a protocol integration surface. Misleading transport semantics cause performance, reliability, and debugging problems. A caller choosing SSE or stdio should know whether they get real streaming/session behavior.

### Implementation Notes

- Add `transportCapabilities` rather than hiding behavior behind names.
- Keep request-spawn stdio as a supported mode if useful, but do not call it persistent session mode.
- Real SSE can be delayed if unsupported errors are explicit.

### Tests To Add

- Request-spawn mode reports non-persistent capability.
- SSE unsupported path returns typed error until implemented.
- Persistent stdio, if added, handles child exit, timeout, cancellation, and bounded output.
- Reliability manager integration does not break existing direct clients.

## DZ-GAP-003: Plugin Lifecycle Is Unsafe For Dynamic Use

### Current Evidence

- Manifest validation is shallow.
- Duplicate discovered plugin names overwrite in a `Map`-style flow.
- Event subscriptions are not tracked for unload/dispose.
- `entryPoint` discovery is metadata-only.

### Why This Matters

Plugins create long-lived process hooks. Without lifecycle and strict manifest behavior, test suites and production hosts can leak handlers, shadow plugins, or load invalid metadata.

### Implementation Notes

- Manifest hardening should land before runtime loading.
- Runtime loading must not be added without root allowlists and path safety.
- Keep conflict diagnostics actionable: plugin name, source, path, and prior source.

### Tests To Add

- Invalid manifest fields fail with specific messages.
- Duplicate names fail unless explicit override is set.
- Dispose prevents future handler invocation.
- Unsafe `entryPoint` paths fail validation.

## DZ-GAP-004 / DZ-GAP-005: Event And OTEL Drift

### Current Evidence

- Event union is broad and manually maintained.
- Some forwarding uses casts.
- Event log append failures are swallowed.
- OTEL in-memory sinks can grow and cost attribution has placeholders.

### Why This Matters

Events and telemetry are trust surfaces for operators. The framework can remain fail-soft, but failures and placeholder data must be visible.

### Implementation Notes

- A central event registry can start as a static typed map; code generation is optional later.
- Add retention config to in-memory stores with safe defaults.
- Separate cost and token warning states.

### Tests To Add

- Event descriptors cover all emitted event types in targeted packages.
- Event forwarding cannot compile with mismatched payloads.
- EventLogSink failure callback fires on append rejection.
- OTEL pruning keeps arrays bounded.

## DZ-GAP-009: Flow-To-Planning Lowering Is Future-Only

### Current Evidence

- Flow lowering docs say no target emits `planning-dag` or `team-runtime`.
- Phase-level team lowering and checkpoint-to-resume mapping are future-only.

### Why This Matters

Flow, planning, and team runtime are adjacent concepts. Without a formal boundary, downstream apps may build incompatible bridges.

### Implementation Notes

- Add contract first; implementation second.
- Prefer one target first, likely planning DAG, because team runtime semantics are more operationally loaded.
- Unsupported nodes should produce structured diagnostics.

### Tests To Add

- Sequence maps IDs and dependencies.
- Branch/parallel preserve ordering and levels.
- Memory/checkpoint nodes produce explicit supported or unsupported diagnostics.

## DZ-GAP-010: Capability Auth Is Configured But Not Enforced

### Current Evidence

- Architecture docs say `requiredCapabilities` is not used by `AgentAuth`.
- Replay and key storage are in-memory/process-local.
- No combined verify/replay API exists.

### Why This Matters

This is security-sensitive because configuration can imply authorization that does not happen. It should be fixed before broader auth feature work.

### Implementation Notes

- Define capability claims clearly before enforcement.
- Preserve compatibility by returning diagnostics rather than throwing everywhere.
- Add durable store interfaces, but keep in-memory defaults for local/test.

### Tests To Add

- Required capability missing fails.
- Required capability present passes.
- Expired or malformed claim fails.
- Combined helper performs signature, replay, and capability checks.

## DZ-GAP-011: Document Connector Validation And Telemetry

### Current Evidence

- Docs list invalid chunk options not explicitly validated.
- No built-in metrics, tracing, or structured logging for parse/chunk latency and failures.

### Why This Matters

Document parsing/chunking can feed RAG/codegen flows. Bad chunk parameters can degrade output, and missing telemetry makes ingestion failures harder to diagnose.

### Implementation Notes

- Keep validation narrow and local.
- Telemetry should be optional callback/event style, not a hard OTEL dependency.

### Tests To Add

- Negative, zero, NaN, and too-large chunk sizes fail.
- Overlap greater than or equal to chunk size fails.
- Telemetry callback receives success/failure duration fields.
