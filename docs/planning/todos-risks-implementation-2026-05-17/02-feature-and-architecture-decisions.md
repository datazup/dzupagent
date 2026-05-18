# DzupAgent Feature And Architecture Decisions

Date: 2026-05-17

## Decision DZ-ADR-001: Remote Memory Protocol Before Transport Implementation

Status: Proposed

### Context

`HttpMemoryClient` and remote IPC endpoint mode exist as public concepts but are not implemented. Implementing transport behavior without a stable protocol would lock in accidental semantics.

### Decision

Define a memory transport protocol first, then implement HTTP and IPC transports against a shared contract suite.

### Required Changes

- Add memory protocol schemas for request, response, errors, health, and batch operations.
- Add a shared contract-test suite that can run against in-memory, HTTP mock, IPC backing-service, and future remote IPC implementations.
- Implement `HttpMemoryClient` with base URL normalization, API key header support, timeout/AbortSignal support, JSON schema validation, tenant scope validation, and typed error mapping.
- Keep endpoint-based IPC disabled until frame format and lifecycle are documented.

### Non-Goals

- Do not add app-specific memory tenancy rules into DzupAgent.
- Do not add Redis/Qdrant remote backend promises unless `@dzupagent/memory` actually supports them.

## Decision DZ-ADR-002: MCP Transport Semantics Must Be Explicit

Status: Proposed

### Context

Current MCP stdio behavior is request-spawn based and SSE discovery uses HTTP semantics. Those are valid implementation choices only if named honestly.

### Decision

Expose transport capabilities explicitly and fail closed for unsupported semantics.

### Required Changes

- Rename or document request-spawn stdio as a distinct transport mode.
- Add persistent stdio transport only with lifecycle, heartbeat, cancellation, bounded buffering, and exit-code guarantees.
- Implement real SSE streaming or return a typed unsupported transport error.
- Allow `MCPClient` to optionally compose reliability and connection-pool helpers by config.
- Add `McpManagerStore` or similar persistence interface while keeping in-memory implementation available for tests/local use.

### Non-Goals

- Do not move app-facing MCP feature descriptors into DzupAgent; those belong in `shared-kit` or apps.

## Decision DZ-ADR-003: Plugin Discovery Must Be Safe Before Dynamic Loading

Status: Proposed

### Context

Plugin discovery currently validates shallow manifests and does not import `entryPoint`. Event subscriptions have no unload path.

### Decision

Harden manifest and lifecycle first; only add runtime loading after path/source policy is explicit.

### Required Changes

- Strict manifest parser with semver, source enum, array item validation, path-safety validation, and actionable diagnostics.
- Duplicate plugin names fail with conflict diagnostics.
- Register event subscriptions through tracked disposers.
- Add `disposePlugin` and `unregisterPlugin` lifecycle APIs.
- Decide whether npm-source discovery is supported; if not, remove or mark it future-only.

## Decision DZ-ADR-004: Events Need A Central Registry

Status: Proposed

### Context

`DzupEvent` is broad and manually updated across files. Some forwarding paths cast to `DzupEvent`.

### Decision

Create a central event registry that drives type unions, docs, and validation fixtures.

### Required Changes

- Define event descriptors with type, payload schema/type, domain, stability, and producer packages.
- Generate or derive `DzupEvent` from descriptors.
- Replace forwarding casts with typed mappers.
- Add docs generation for event catalog.
- Add tests that ensure package producers use declared event types.

## Decision DZ-ADR-005: OTEL In-Memory Sinks Need Retention And Truthful Cost Semantics

Status: Proposed

### Context

OTEL helpers currently provide useful local observability but have retention and placeholder cost limitations.

### Decision

Keep in-memory sinks but make retention configurable and separate placeholder examples from production cost attribution.

### Required Changes

- Add max entries/max samples/window configuration for metric and audit stores.
- Add pruning tests.
- Integrate real usage records from provider/tool events into cost attribution.
- Split cost warning state from token warning state.
- Complete audit category mapping or remove unsupported categories from docs.

## Decision DZ-ADR-006: HITL Preference Resolution Is A Framework Extension Point, Not An App Model

Status: Proposed

### Context

Human contact channel resolution mentions user profile preference, but app user models vary.

### Decision

Add an optional resolver interface instead of importing any app profile shape.

### Required Changes

- Add `HumanContactPreferenceResolver` type.
- Let agent/run config inject resolver.
- Preserve current explicit-channel, agent-default, and fallback behavior.
- Add tests for every resolution branch.

## Decision DZ-ADR-007: Server Compatibility Facades Need Explicit Public API Status

Status: Proposed

### Context

Source includes server runtime and compat facades, but package exports expose only root and `./ops` according to current docs.

### Decision

Either publish those facades intentionally or mark them internal and remove misleading consumer expectations.

### Required Changes

- Fix health version source.
- Decide export-map status for `runtime` and `compat`.
- Update server API surface allowlist if public.
- Add migration docs if consumers should move to another subpath.

## Decision DZ-ADR-008: Flow-To-Planning Lowering Needs An Explicit Contract

Status: Proposed

### Context

The current flow lowering contract marks planning DAG/team-runtime targets, phase-level team lowering, and checkpoint-to-resume mapping as future-only. That is acceptable if documented, but it should not remain an ambiguous TODO because orchestration consumers can easily assume a direct lowering path exists.

### Decision

Add an explicit Flow-to-Planning contract before implementing runtime lowering.

### Required Changes

- Define whether `FlowDocumentV1` can lower to `ExecutionPlan`, `TeamDefinition`, or both.
- Preserve node IDs, dependencies, branch/parallel structure, memory reads, and checkpoint intent in a deterministic intermediate representation.
- Add unsupported-node diagnostics instead of best-effort partial lowering.
- Add fixtures that prove branch, parallel, memory, checkpoint, and delegation behavior.
- Keep product-specific planning semantics out of `flow-compiler`; app-specific orchestration stays in consuming apps.

## Decision DZ-ADR-009: Agent Capability Authorization Must Be Enforced Or Removed From Config

Status: Proposed

### Context

`AgentAuthConfig.requiredCapabilities` is documented but not enforced by `AgentAuth`. This is a security-sensitive mismatch: configured capability requirements can look active while only signature/replay checks are being used.

### Decision

Either enforce capability checks in the auth path or remove/rename the config until enforcement exists. Preferred path is enforcement with compatibility-safe diagnostics.

### Required Changes

- Add a signed capability claim shape and validation rules.
- Add `verifyAndCheckReplay` or equivalent combined API so callers do not forget one half of the check.
- Add optional durable replay/public-key stores for distributed deployments.
- Add tests for missing, insufficient, expired, and malformed capability claims.

## Decision DZ-ADR-010: Gitleaks Allowlist Governance Is A First-Class Verification Gate

Status: Proposed

### Context

The latest tree adds anchored gitleaks allowlist regexes and a validator script. That is a useful hardening step, but allowlists are sensitive because overly broad patterns can hide real secrets.

### Decision

Keep the allowlist validator as a required verification gate and document rules for future allowlist changes.

### Required Changes

- Keep `check:gitleaks-allowlist` inside `verify` and `verify:strict`.
- Keep security workflow validation before the gitleaks scan.
- Extend the validator if future allowlists need owner/rationale metadata.
- Require tests for regex parsing, anchoring, invalid regexes, and future metadata constraints.

## Decision DZ-ADR-011: Document Connector Inputs Need Validation And Telemetry

Status: Proposed

### Context

The document connector architecture notes invalid chunk settings and missing parse/chunk telemetry. These are not broad framework architecture issues, but they can cause poor runtime output and weak operator visibility.

### Decision

Add narrow input validation and package-level telemetry hooks without turning the connector package into an observability framework.

### Required Changes

- Validate `maxChunkSize`, `overlap`, MIME type, and parser-specific limits at the connector boundary.
- Emit optional parse/chunk latency and failure events through existing event or callback seams.
- Keep telemetry optional and dependency-light.
- Add tests for negative/zero/too-large chunk options and telemetry callback behavior.
