## DzipAgent Ecosystem Implementation Review (Updated)

Date: 2026-03-29
Scope: monorepo implementation status, architecture consistency, refactor targets, and migration priorities.

### 1) Current Implementation Reality

The codebase has strong coverage across identity, protocol, memory, orchestration, and observability. Several earlier planning assumptions are now outdated.

Implemented highlights:
- Identity and trust in `@dzipagent/core`: `ForgeIdentity`, `ForgeUri`, `APIKeyResolver`, `DelegationManager`, `TrustScorer`.
- Protocol envelope and adapters in `@dzipagent/core`: `ForgeMessage`, `ProtocolAdapter`, `InternalAdapter`, `A2AClientAdapter`, routing and schema validation.
- Memory capabilities in `@dzipagent/memory`: shared spaces, provenance, causal graph, CRDT sync/enrichment, retention policies.
- Observability in `@dzipagent/otel`: `DzipTracer`, `OTelBridge`, `AuditTrail`, plugin integration.
- Runtime orchestration in `@dzipagent/agent`: `PipelineRuntime`, checkpoint store integration, loop/fork/join/suspend, retry/recovery hooks.

### 2) Corrected Gap Analysis

#### A. Runtime/Workflow fragmentation is real, but shape differs from older docs

Execution paths currently present:
1. `PipelineRuntime` (`packages/agent/src/pipeline`) — canonical runtime engine.
2. `WorkflowBuilder` (`packages/agent/src/workflow`) — now compiled to `PipelineDefinition` and executed by `PipelineRuntime`.
3. `PipelineExecutor` (`packages/codegen/src/pipeline`) — legacy phase executor path.
4. `AdapterWorkflowBuilder` (`packages/agent-adapters/src/workflow`) — adapter-facing workflow engine.

Action: treat `PipelineRuntime` + core `PipelineDefinition` as canonical execution substrate, with adapters/DSLs compiling into it over time.

#### B. K8s/operator integration remains incomplete in monorepo packaging

- `@dzipagent/codegen` includes k8s CRD types/client/sandbox APIs.
- Some tests import `k8s/operator/...` source paths that are not present in this repository snapshot.

Action: either vendor operator source into the monorepo (`packages/operator`) or formalize the boundary with interface-level tests and remove hard relative imports to absent paths.

#### C. Safety and audit are implemented in both core and otel layers

- Core already has `createSafetyMonitor` and security audit/event mapping primitives.
- OTel layer has its own monitor/bridge/audit concerns with observability focus.

Action: keep enforcement contracts in core, keep otel monitors as observability plugins, and ensure block/kill enforcement points are wired in runtime/server control paths.

#### D. URI alignment has improved but still needs runtime enforcement

- Memory/provenance types now document strict `forge://org/agent-name` format.
- Field types are still mostly plain `string`.

Action: enforce URI validation at write boundaries and progressively tighten to branded/shared URI types where package boundaries permit.

### 3) Quality Assessment

- Typing discipline is strong (strict TS patterns, good union usage).
- Test coverage breadth is high across most packages.
- Package boundaries are generally clear, with remaining debt mostly in orchestration/runtime overlap and deployment packaging.

### 4) Priority Improvement Plan

P0 (immediate):
1. Canonical runtime map and migration ownership (this doc + `docs/canonical_runtime_migration_map.md`).
2. Keep `PipelineRuntime` as runtime of record; route workflow DSLs to compiled pipeline execution.

P1:
1. Deprecation strategy for `PipelineExecutor` and adapter workflow runtime duplication.
2. K8s operator packaging decision (in-repo package vs strict external contract).
3. Core-vs-otel safety layering formalized in docs and interfaces.

P2:
1. URI hardening in memory/provenance runtime writes.
2. Orchestration event coverage parity in OTel bridge for coordination primitives.
3. Durable checkpoint backends beyond in-memory defaults.

### 5) Immediate Status Update

Completed in this cycle:
- `WorkflowBuilder` now compiles to core `PipelineDefinition`.
- `CompiledWorkflow.run()` now executes through `PipelineRuntime`.
- `CompiledWorkflow` exposes `toPipelineDefinition()` for canonical introspection.
- Workflow tests updated for suspend behavior and canonical compilation assertions.

