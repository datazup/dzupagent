# Agent Pattern Audit

## Findings

### AGENT-001 - High - Disabled adapters can still execute through direct adapter lookup paths

Impact: An operator can disable a provider in `ProviderAdapterRegistry`, but several orchestration paths that call `getHealthy()` directly can still execute it. This weakens routing and emergency-disable controls for parallel execution and contract-net bidding.

Evidence: `disable()` records disabled providers and `isEnabled()` checks that set in `packages/agent-adapters/src/registry/adapter-registry.ts:155`, but `getHealthy()` only checks registration and circuit-breaker state in `packages/agent-adapters/src/registry/adapter-registry.ts:178`. The fallback registry path uses `getHealthyProviderIds()`, which does exclude disabled providers in `packages/agent-adapters/src/registry/adapter-registry.ts:535`, but `ParallelExecutor.runSingleProvider()` calls `registry.getHealthy(providerId)` directly in `packages/agent-adapters/src/orchestration/parallel-executor.ts:410`, and `ContractNetOrchestrator` builds available providers from `listAdapters().filter(getHealthy)` in `packages/agent-adapters/src/orchestration/contract-net.ts:324`.

Remediation: Make `getHealthy()` return `undefined` for disabled adapters, or introduce an explicit `getExecutable()` used by all execution paths. Add regression tests for disabled providers through fallback, parallel, supervisor, and contract-net orchestration.

### AGENT-002 - High - Parallel adapter execution treats a stream without `adapter:completed` as success

Impact: A provider stream that ends after progress/message events, or with no terminal event, is reported as a successful empty result. `first-wins` can select that empty result and cancel real providers, while `all`/`best-of-n` can rank false successes.

Evidence: `ProviderAdapterRegistry.executeWithFallbackWithRaw()` requires a terminal `adapter:completed` event and synthesizes failure when the stream ends without one in `packages/agent-adapters/src/registry/adapter-registry.ts:268` and `packages/agent-adapters/src/registry/adapter-registry.ts:300`. `ParallelExecutor.runSingleProvider()` returns `success: true` after the async iterator ends even when no completed event was observed in `packages/agent-adapters/src/orchestration/parallel-executor.ts:432` and `packages/agent-adapters/src/orchestration/parallel-executor.ts:488`.

Remediation: Mirror the registry terminal-event invariant in `ParallelExecutor`: track `sawCompleted` and `sawFailed`, return failure on missing terminal completion, and record provider failure where the registry exposes that capability.

### AGENT-003 - High - Planning execution can corrupt results when a parallel level contains duplicate specialist IDs

Impact: If two plan nodes in the same execution chunk target the same specialist, only one result survives because aggregation is keyed by specialist ID. The second plan node can receive the first node's output, dependency propagation becomes wrong, and failures can be hidden.

Evidence: `PlanningAgent.executePlan()` builds assignments with `_nodeId` in the input in `packages/agent/src/orchestration/planning-agent.ts:323`, then reads results with `aggregated.results.get(node.specialistId)` in `packages/agent/src/orchestration/planning-agent.ts:348`. `DelegatingSupervisor` defines aggregated results as `Map<string, DelegationResult>` keyed by specialist ID in `packages/agent/src/orchestration/delegating-supervisor.ts:47` and stores each result by `assignment.specialistId` in `packages/agent/src/orchestration/delegating-supervisor.ts:304`.

Remediation: Key batch delegation results by assignment ID or node ID, not specialist ID. Keep specialist ID as metadata. Add a plan test with two same-specialist nodes in one execution level and distinct outputs.

### AGENT-004 - Medium - Provider-adapter supervisor mode silently falls back to local agent mode when the port is missing

Impact: A caller that requests `executionMode: 'provider-adapter'` without injecting `providerPort` gets normal local-agent supervisor execution instead of a configuration failure. That can bypass the intended provider adapter routing, fallback, and audit path.

Evidence: `SupervisorConfig` says `providerPort` is required when `executionMode` is `'provider-adapter'` in `packages/agent/src/orchestration/orchestrator.ts:33`. Runtime only enters the provider-port path when both `executionMode === 'provider-adapter'` and `providerPort` are truthy in `packages/agent/src/orchestration/orchestrator.ts:268`; otherwise execution continues into local specialist tools in `packages/agent/src/orchestration/orchestrator.ts:285`.

Remediation: Fail closed when `executionMode === 'provider-adapter'` and `providerPort` is missing. Add a unit test that asserts this configuration error.

### AGENT-005 - Medium - DelegatingSupervisor provider-port path drops task input, parent context, cancellation, and duration

Impact: Adapter-backed delegation does not receive the structured `input` passed by the planner, does not pass `parentContext`, does not accept an abort signal on `delegateTask()`, and records `durationMs: 0`. That makes provider-port delegation semantically weaker than tracker delegation and less useful for audit and timeout analysis.

Evidence: `TaskAssignment` includes structured `input` in `packages/agent/src/orchestration/delegating-supervisor.ts:37`, and the tracker path sends `input` plus `context` in `packages/agent/src/orchestration/delegating-supervisor.ts:226`. The provider-port path calls `providerPort.run({ prompt: task }, { prompt: task, tags })` and then hardcodes duration metadata to zero in `packages/agent/src/orchestration/delegating-supervisor.ts:195`.

Remediation: Extend `delegateTask()` to accept options including `signal` and run ID, pass structured input/context through `AgentInput.options` or a documented field, measure real duration, and propagate `ProviderExecutionResult` metadata.

### AGENT-006 - Medium - DelegatingSupervisor does not record circuit-breaker failures for generic failed delegations

Impact: Non-timeout delegation failures do not trip the configured circuit breaker. A repeatedly failing specialist can stay eligible forever unless failures contain the word `timeout`.

Evidence: The tracker path records success and timeout only in `packages/agent/src/orchestration/delegating-supervisor.ts:235`. There is no `recordFailure()` branch for `result.success === false` with a non-timeout error. Rejected `delegateTask()` promises are converted to failed results in `delegateAndCollect()` in `packages/agent/src/orchestration/delegating-supervisor.ts:304`, but that path also does not update the circuit breaker.

Remediation: Record generic failures through `circuitBreaker.recordFailure(specialistId)` for non-timeout unsuccessful results and for rejected delegations. Add tests for failure, timeout, and success transitions.

### AGENT-007 - Medium - LLM routing is synchronous pass-through in current supervisor entrypoints

Impact: A policy named `LLMRouting` does not perform an LLM selection in the common routing-policy entrypoint. Consumers can believe they are using model-based routing while every candidate remains selected.

Evidence: `LLMRouting.select()` returns all candidates with strategy `llm` in `packages/agent/src/orchestration/routing/llm-routing.ts:13`. `AgentOrchestrator.supervisor()` applies `routingPolicy.select()` and filters specialists from `decision.selected` in `packages/agent/src/orchestration/orchestrator.ts:324`; it does not call `createDecision()` or any asynchronous LLM chooser.

Remediation: Rename this policy to a pass-through adapter, or add an async LLM routing interface and wire it into supervisor/delegation entrypoints with an explicit fallback path.

### AGENT-008 - Medium - Contract-net manager is required by type but unused by protocol execution

Impact: The public `ContractNetConfig` implies a manager/coordinator agent participates in the protocol, but the implementation ignores it. This creates misleading topology semantics and leaves no manager-side audit or award reasoning.

Evidence: `ContractNetManager.execute()` destructures `specialists`, `task`, signal, event bus, retry, cost, and required capabilities but not `manager` in `packages/agent/src/orchestration/contract-net/contract-net-manager.ts:144`. Bids are collected directly from specialists in `packages/agent/src/orchestration/contract-net/contract-net-manager.ts:185`, then a strategy ranks them in `packages/agent/src/orchestration/contract-net/contract-net-manager.ts:241`.

Remediation: Either remove `manager` from the contract or use it for CFP construction, bid evaluation, award explanation, and audit events. Add a contract test that fails if a supplied manager is silently unused.

### AGENT-009 - Medium - Contract-net adapter failures do not consistently update registry circuit state

Impact: A provider that emits `adapter:failed` without throwing can be retried in future contract-net runs without its registry circuit breaker reflecting the failure.

Evidence: `ContractNetOrchestrator.executeWithFallback()` records registry failure only in the `catch` branch in `packages/agent-adapters/src/orchestration/contract-net.ts:525`. `consumeAdapterEvents()` captures failed events as `errorMessage` and returns `success: false` in `packages/agent-adapters/src/orchestration/contract-net.ts:561`, but the caller only assigns `lastError` in `packages/agent-adapters/src/orchestration/contract-net.ts:523` and continues without `registry.recordFailure()`.

Remediation: Record failure for every unsuccessful bid execution result, not only thrown exceptions. Keep terminal-event failure semantics consistent with the fallback registry.

### AGENT-010 - Medium - Topology auto-switch cannot recover thrown failures from routed topologies

Impact: `autoSwitch` only runs after a topology returns metrics with a high error rate. Pipeline, star, and hierarchical paths can throw before metrics exist, so the advertised auto-switch behavior cannot recover those failures.

Evidence: `TopologyExecutor.execute()` awaits `executeTopology()` before evaluating `autoSwitch` in `packages/agent/src/orchestration/topology/topology-executor.ts:157`. The retry logic is only inside the post-result error-rate branch in `packages/agent/src/orchestration/topology/topology-executor.ts:166`. Pipeline/star/hierarchical delegate to `AgentOrchestrator` with `errorCount: 0` on success and no catch around thrown errors in `packages/agent/src/orchestration/topology/topology-executor.ts:215`.

Remediation: Wrap initial topology execution when `autoSwitch` is enabled, synthesize failure metrics for thrown errors, and retry a recommended alternate topology before surfacing the original failure.

### AGENT-011 - Medium - TeamRuntime reports incorrect pattern labels for contract-net and breaker-short-circuit runs

Impact: Downstream telemetry, UI, and synthesis reports can misclassify team runs. Contract-net and all-breaker-open runs are reported as `peer-to-peer`, which hides the actual coordinator pattern.

Evidence: The all-circuits-open early return sets `pattern: 'peer-to-peer'` in `packages/agent/src/orchestration/team/team-runtime.ts:388`. The contract-net runner also returns `pattern: 'peer-to-peer'` in `packages/agent/src/orchestration/team/team-runtime.ts:587`, despite executing `ContractNetManager.execute()` in `packages/agent/src/orchestration/team/team-runtime.ts:567`.

Remediation: Extend `TeamRunResult` pattern typing if necessary and return the actual coordinator pattern for every branch. Add table-driven tests for all coordinator patterns.

### AGENT-012 - Medium - Team policy surface exposes controls that are not enforced by TeamRuntime

Impact: Consumers can configure governance, memory, isolation, mailbox, and evaluation policies and assume they affect execution, but the runtime only validates parts of `execution` and stores the rest. This is a product-boundary risk for reusable team primitives.

Evidence: `TeamPolicies` includes `governance`, `memory`, `isolation`, `mailbox`, and `evaluation` in `packages/agent/src/orchestration/team/team-policy.ts:90`. `TeamRuntime` stores policies in `packages/agent/src/orchestration/team/team-runtime.ts:224` and validates unsupported execution fields in `packages/agent/src/orchestration/team/team-runtime.ts:236`, but inspected pattern methods call only execution max-parallel/max-round helpers and do not enforce those other policy groups.

Remediation: Either reject unsupported policy groups fail-closed like `timeoutMs` and retry fields, or implement enforcement hooks with explicit audit events for each policy group.

### AGENT-013 - Medium - Blackboard team context grows without token or size budget

Impact: Blackboard runs can append every participant's full contribution for every round into a shared prompt. Larger teams or repeated rounds can exceed provider context windows and degrade routing or cost controls.

Evidence: `runBlackboard()` stores task and round values, then each participant receives `workspace.formatAsContext()` and writes its full result back to the same workspace in `packages/agent/src/orchestration/team/team-runtime.ts:621`. The loop at `packages/agent/src/orchestration/team/team-runtime.ts:638` has no token estimator, truncation, summarization, or memory policy enforcement.

Remediation: Add a blackboard context budget using existing context/token utilities, compact older contributions, and wire `MemoryPolicy.consolidateOnComplete` or reject it until implemented.

### AGENT-014 - Medium - Planning decomposition silently drops unknown-specialist nodes and dependencies

Impact: LLM decomposition can lose tasks without surfacing a planning failure. A plan can execute successfully after removing nodes that were part of the original dependency graph, making the resulting work incomplete.

Evidence: `PlanningAgent.decompose()` filters unknown specialists into `removedNodeIds` in `packages/agent/src/orchestration/planning-agent.ts:441`, then removes dependencies on removed or missing nodes in `packages/agent/src/orchestration/planning-agent.ts:468`. It only throws when all nodes are removed in `packages/agent/src/orchestration/planning-agent.ts:460`.

Remediation: Treat removed nodes or dangling dependencies as validation errors by default, or return diagnostics requiring caller acknowledgement before execution.

### AGENT-015 - Medium - ContextAwareRouter priority ordering accidentally promotes providers missing from the priority list

Impact: Providers not included in `PROVIDER_PRIORITY` sort ahead of known providers because `indexOf()` returns `-1`. If `openrouter`, `goose`, `gemini-sdk`, or future providers fit the context, they can be selected over the documented priority order.

Evidence: Defaults include context windows for `goose`, `gemini-sdk`, `openrouter`, and `openai` in `packages/agent-adapters/src/context/context-aware-router.ts:69`, but `PROVIDER_PRIORITY` includes only `claude`, `codex`, `gemini`, `qwen`, and `crush` in `packages/agent-adapters/src/context/context-aware-router.ts:85`. Fitting providers are sorted by `PROVIDER_PRIORITY.indexOf()` subtraction in `packages/agent-adapters/src/context/context-aware-router.ts:210`.

Remediation: Map missing providers to `Number.MAX_SAFE_INTEGER` and add all supported providers to an explicit priority list. Add a router test where `openrouter` and `claude` both fit.

### AGENT-016 - Medium - OpenAI provider support is inconsistent across catalog and HTTP routing schemas

Impact: `OpenAIAdapter` exists and `AdapterProviderId` includes `openai`, but product/provider surfaces can reject it or omit it. This creates inconsistent behavior between direct package consumers and HTTP adapter orchestration.

Evidence: `OpenAIAdapter` implements `providerId: 'openai'` in `packages/agent-adapters/src/openai/openai-adapter.ts:73`, and shared adapter types include `openai` in `packages/adapter-types/src/contracts/provider.ts:11`. The product catalog omits `openai` from `PROVIDER_CATALOG` in `packages/agent-adapters/src/provider-catalog.ts:32`, while HTTP request schemas omit it from `AdapterProviderIdSchema` in `packages/agent-adapters/src/http/request-schemas.ts:10`.

Remediation: Decide whether OpenAI is framework-only, product-integrated, or unsupported in this package. Encode that decision in the catalog, HTTP schemas, and tests from one generated or shared provider list.

### AGENT-017 - Low - Registry fallback emits inconsistent run IDs for one provider attempt

Impact: Observability consumers cannot reliably correlate `agent:started`, `agent:completed`, and `agent:failed` events for the same provider attempt by run ID.

Evidence: Start events use `${providerId}-${Date.now()}` in `packages/agent-adapters/src/registry/adapter-registry.ts:273`; completion uses `${providerId}-${startMs}` in `packages/agent-adapters/src/registry/adapter-registry.ts:303`; failure uses `${providerId}-fallback` in `packages/agent-adapters/src/registry/adapter-registry.ts:325`.

Remediation: Allocate a single `attemptRunId` per provider attempt and reuse it for all terminal events. Preserve any caller-supplied run ID through `ProviderExecutionPort` bridging.

### AGENT-018 - Low - Supervisor adapter progress events hardcode provider ID

Impact: Progress telemetry from adapter supervisor orchestration always appears to come from Claude, even when another provider or mixed providers are executing.

Evidence: `SupervisorOrchestrator.emitProgressEvent()` constructs `providerId: 'claude'` in `packages/agent-adapters/src/orchestration/supervisor.ts:501`.

Remediation: Emit progress events at the supervisor/run level without a provider ID, or pass the active provider ID(s) into the progress helper.

### AGENT-019 - Low - Orchestrator routing diagnostics are console-only in direct agent supervisor

Impact: Circuit-breaker filtering and routing decisions are visible in local logs but not on the framework event bus, so audit sinks cannot observe why specialists were selected or filtered.

Evidence: `AgentOrchestrator.supervisor()` logs circuit-breaker filtering with `console.debug()` in `packages/agent/src/orchestration/orchestrator.ts:303` and logs routing decisions with `console.debug()` in `packages/agent/src/orchestration/orchestrator.ts:324`. `SupervisorConfig` has no event bus field in `packages/agent/src/orchestration/orchestrator.ts:21`.

Remediation: Add optional event hooks or an event bus to the direct orchestrator config and emit structured routing/filtering events while keeping console logging optional.

### AGENT-020 - Low - MapReduce public type omits built-in merge strategies supported by the registry

Impact: TypeScript callers cannot select `numbered` or `json` merge strategies even though the runtime registry supports them. They must cast strings or provide custom functions.

Evidence: `MapReduceConfig.mergeStrategy` allows only `'concat'`, `'vote'`, and `'custom'` in `packages/agent/src/orchestration/map-reduce.ts:18`. `getMergeStrategy()` supports `concat`, `vote`, `numbered`, and `json` in `packages/agent/src/orchestration/merge-strategies.ts:53`.

Remediation: Export a shared `MergeStrategyName` union from the registry and use it in MapReduce and other orchestration APIs.

### AGENT-021 - Low - Topology metrics define provider-adapter fields no topology executor populates

Impact: The metrics contract suggests topology execution can report provider IDs, fallback attempts, and attempted providers, but current topology execution never routes through provider adapters. Consumers can overread empty fields as instrumentation gaps.

Evidence: `TopologyMetrics` includes provider adapter fields in `packages/agent/src/orchestration/topology/topology-types.ts:37`. `TopologyExecutor` fills only topology, duration, agent count, message count, error count, and sometimes `switchedFrom` in `packages/agent/src/orchestration/topology/topology-executor.ts:74`, `packages/agent/src/orchestration/topology/topology-executor.ts:136`, and `packages/agent/src/orchestration/topology/topology-executor.ts:221`.

Remediation: Remove the fields from topology metrics until provider-adapter topology exists, or add a real provider-adapter topology path that populates them.

### AGENT-022 - Low - OpenAI raw event normalization is absent from the shared normalizer

Impact: Persisted raw OpenAI events cannot be replayed through the common `normalizeEvent()` utility, unlike other supported providers. This creates a gap for audit/replay tooling that relies on provider-agnostic normalization.

Evidence: `normalizeEvent()` branches for Claude, Codex, Gemini, Goose, Qwen, Crush, and OpenRouter, then returns null by default in `packages/agent-adapters/src/normalize.ts:53`. `OpenAIAdapter` emits canonical events directly in `packages/agent-adapters/src/openai/openai-adapter.ts:253`, but there is no `normalizeOpenAI()` branch for raw SSE/chat payloads.

Remediation: Add OpenAI raw-event normalization or explicitly document that OpenAI bypasses raw-event replay. Prefer adding tests using captured SSE chunks and non-streaming chat responses.

### AGENT-023 - Info - Tool governance and lifecycle telemetry remain opt-in

Impact: The current tool loop has strong policy hooks, but default agents without `toolExecution` still run without canonical tool lifecycle event forwarding, governance, permission policy, or safety result scanning. This is acceptable for backward compatibility but should not be described as always-on.

Evidence: `executeGenerateRun()` forwards tool governance, safety monitor, timeouts, validation, permission policy, agent ID, run ID, and event bus only when `config.toolExecution` is present in `packages/agent/src/agent/run-engine.ts:246`. The production preset composes fail-closed scanning, allowlist permissions, governance, timeouts, and validation in `packages/agent/src/agent/production-tool-governance-preset.ts:68`.

Remediation: Keep framework defaults backward-compatible, but document that products requiring audit-grade tool execution must use `createProductionToolGovernancePreset()` or equivalent config. Add a product-level wiring test where applicable.

### AGENT-024 - Info - Tool result audit can retain raw output through governance sinks

Impact: Canonical event-bus tool events avoid raw input and do not put output on `tool:result`, but `ToolGovernance.auditResult()` receives raw output. That may be intended, but retention policy should be explicit for deployments with stricter audit requirements.

Evidence: `emitToolCalled()` records only `inputMetadataKeys` in the event path and governance audit entry in `packages/agent/src/agent/tool-lifecycle-policy.ts:109`. `emitToolResult()` sends raw `output` to `toolGovernance.auditResult()` in `packages/agent/src/agent/tool-lifecycle-policy.ts:185`, and `executePolicyEnabledToolCall()` passes the transformed result string into that function in `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:289`.

Remediation: Document retention semantics for governance audit sinks and add a redaction or metadata-only mode for products that cannot store raw tool outputs.

## Finding Manifest

```json
{
  "domain": "agent patterns",
  "counts": { "critical": 0, "high": 3, "medium": 13, "low": 6, "info": 2 },
  "findings": [
    { "id": "AGENT-001", "severity": "high", "title": "Disabled adapters can still execute through direct adapter lookup paths", "file": "packages/agent-adapters/src/registry/adapter-registry.ts" },
    { "id": "AGENT-002", "severity": "high", "title": "Parallel adapter execution treats a stream without adapter:completed as success", "file": "packages/agent-adapters/src/orchestration/parallel-executor.ts" },
    { "id": "AGENT-003", "severity": "high", "title": "Planning execution can corrupt results when a parallel level contains duplicate specialist IDs", "file": "packages/agent/src/orchestration/planning-agent.ts" },
    { "id": "AGENT-004", "severity": "medium", "title": "Provider-adapter supervisor mode silently falls back to local agent mode when the port is missing", "file": "packages/agent/src/orchestration/orchestrator.ts" },
    { "id": "AGENT-005", "severity": "medium", "title": "DelegatingSupervisor provider-port path drops task input, parent context, cancellation, and duration", "file": "packages/agent/src/orchestration/delegating-supervisor.ts" },
    { "id": "AGENT-006", "severity": "medium", "title": "DelegatingSupervisor does not record circuit-breaker failures for generic failed delegations", "file": "packages/agent/src/orchestration/delegating-supervisor.ts" },
    { "id": "AGENT-007", "severity": "medium", "title": "LLM routing is synchronous pass-through in current supervisor entrypoints", "file": "packages/agent/src/orchestration/routing/llm-routing.ts" },
    { "id": "AGENT-008", "severity": "medium", "title": "Contract-net manager is required by type but unused by protocol execution", "file": "packages/agent/src/orchestration/contract-net/contract-net-manager.ts" },
    { "id": "AGENT-009", "severity": "medium", "title": "Contract-net adapter failures do not consistently update registry circuit state", "file": "packages/agent-adapters/src/orchestration/contract-net.ts" },
    { "id": "AGENT-010", "severity": "medium", "title": "Topology auto-switch cannot recover thrown failures from routed topologies", "file": "packages/agent/src/orchestration/topology/topology-executor.ts" },
    { "id": "AGENT-011", "severity": "medium", "title": "TeamRuntime reports incorrect pattern labels for contract-net and breaker-short-circuit runs", "file": "packages/agent/src/orchestration/team/team-runtime.ts" },
    { "id": "AGENT-012", "severity": "medium", "title": "Team policy surface exposes controls that are not enforced by TeamRuntime", "file": "packages/agent/src/orchestration/team/team-policy.ts" },
    { "id": "AGENT-013", "severity": "medium", "title": "Blackboard team context grows without token or size budget", "file": "packages/agent/src/orchestration/team/team-runtime.ts" },
    { "id": "AGENT-014", "severity": "medium", "title": "Planning decomposition silently drops unknown-specialist nodes and dependencies", "file": "packages/agent/src/orchestration/planning-agent.ts" },
    { "id": "AGENT-015", "severity": "medium", "title": "ContextAwareRouter priority ordering accidentally promotes providers missing from the priority list", "file": "packages/agent-adapters/src/context/context-aware-router.ts" },
    { "id": "AGENT-016", "severity": "medium", "title": "OpenAI provider support is inconsistent across catalog and HTTP routing schemas", "file": "packages/agent-adapters/src/provider-catalog.ts" },
    { "id": "AGENT-017", "severity": "low", "title": "Registry fallback emits inconsistent run IDs for one provider attempt", "file": "packages/agent-adapters/src/registry/adapter-registry.ts" },
    { "id": "AGENT-018", "severity": "low", "title": "Supervisor adapter progress events hardcode provider ID", "file": "packages/agent-adapters/src/orchestration/supervisor.ts" },
    { "id": "AGENT-019", "severity": "low", "title": "Orchestrator routing diagnostics are console-only in direct agent supervisor", "file": "packages/agent/src/orchestration/orchestrator.ts" },
    { "id": "AGENT-020", "severity": "low", "title": "MapReduce public type omits built-in merge strategies supported by the registry", "file": "packages/agent/src/orchestration/map-reduce.ts" },
    { "id": "AGENT-021", "severity": "low", "title": "Topology metrics define provider-adapter fields no topology executor populates", "file": "packages/agent/src/orchestration/topology/topology-types.ts" },
    { "id": "AGENT-022", "severity": "low", "title": "OpenAI raw event normalization is absent from the shared normalizer", "file": "packages/agent-adapters/src/normalize.ts" },
    { "id": "AGENT-023", "severity": "info", "title": "Tool governance and lifecycle telemetry remain opt-in", "file": "packages/agent/src/agent/run-engine.ts" },
    { "id": "AGENT-024", "severity": "info", "title": "Tool result audit can retain raw output through governance sinks", "file": "packages/agent/src/agent/tool-lifecycle-policy.ts" }
  ]
}
```

## Scope Reviewed

Static source review only. I read the prepared repo snapshot first at `context/repo-snapshot.md`, then selectively inspected current source files for the agent-pattern domain, weighted toward orchestration runtime, routing, teams, delegation, topology, and provider adapter ports.

Primary files reviewed:

- `packages/agent/src/orchestration/**`
- `packages/agent/src/agent/tool-loop.ts`
- `packages/agent/src/agent/tool-loop/**`
- `packages/agent/src/agent/run-engine.ts`
- `packages/agent/src/agent/tool-lifecycle-policy.ts`
- `packages/agent/src/agent/production-tool-governance-preset.ts`
- `packages/agent/src/agent/memory-context-loader.ts`
- `packages/context/src/message-manager.ts`
- `packages/core/src/security/audit/audit-logger.ts`
- `packages/core/src/events/event-types.ts`
- `packages/agent-adapters/src/registry/adapter-registry.ts`
- `packages/agent-adapters/src/orchestration/**`
- `packages/agent-adapters/src/context/context-aware-router.ts`
- `packages/agent-adapters/src/integration/provider-execution-port.ts`
- `packages/agent-adapters/src/provider-catalog.ts`
- `packages/agent-adapters/src/http/request-schemas.ts`
- `packages/agent-adapters/src/openai/openai-adapter.ts`
- `packages/agent-adapters/src/normalize.ts`

Generated artifacts, dependency directories, and old audit artifacts were not used as evidence. I did not run runtime validation or test commands for this audit, so all findings are static current-code findings only.

The local audit command taxonomy was considered structurally only: I compared parser, routing, dispatch, terminal-event, telemetry, fallback, guardrail, and audit shapes conceptually, not as evidence that any local audit command passed or failed.

## Strengths

- The framework has a clean dependency-inverted provider adapter port: `@dzupagent/agent` defines `ProviderExecutionPort`, and `@dzupagent/agent-adapters` implements it through `RegistryExecutionPort`.
- Provider fallback in the central registry now has a strong terminal-event invariant: success requires `adapter:completed`; missing terminal completion becomes a synthesized adapter failure.
- Tool loop governance is well factored when enabled: permissions, governance checks, approval requests, argument validation, timeouts, cancellation, scanner failure behavior, telemetry, tracing, and stuck detection are all in reusable execution stages.
- Streaming and non-streaming tool execution share the same policy vocabulary, and the production preset provides a fail-closed configuration bundle for product consumers.
- Memory and context management have explicit frame/fallback behavior, and run results surface the memory frame for observability.
- Team, topology, planning, contract-net, and delegation primitives are already framework-level rather than server/playground product additions, which matches the repository feature boundary.
- Circuit-breaker support exists across several agent and adapter orchestration paths; the remaining gaps are mostly consistency and coverage issues, not absence of the primitive.

## Open Questions Or Assumptions

- I assumed disabled adapters are intended to be excluded from all execution paths, not only registry fallback routing.
- I assumed `provider-adapter` supervisor mode should fail closed when no port is injected because the config comment says the port is required.
- I assumed `TeamPolicies` fields describe enforceable runtime behavior. If they are intended as future-reserved schema only, the runtime should reject or clearly mark unsupported groups.
- I did not inspect consuming apps such as Codev, so product-level wiring, UI behavior, tenant policy enforcement, and durable audit sink coverage remain outside this baseline review.
- I did not run tests. Existing tests were opened only where useful as source context, not as runtime validation evidence.

## Recommended Next Actions

1. Fix the three high-impact execution correctness issues first: disabled-adapter bypass, parallel missing-terminal success, and duplicate-specialist planning result corruption.
2. Normalize provider-port delegation semantics across `AgentOrchestrator`, `DelegatingSupervisor`, `RegistryExecutionPort`, and adapter orchestration so input/context/signal/run ID/duration/fallback metadata are preserved consistently.
3. Add a focused orchestration regression suite covering provider disablement, terminal adapter events, duplicate specialist plan nodes, provider-port configuration failures, and generic circuit-breaker failures.
4. Decide whether `TeamPolicies` unsupported groups should fail closed or be implemented now. Do not leave policy fields as no-op controls in reusable primitives.
5. Unify provider identity sources for adapter types, catalog, HTTP schemas, context routing, policy compilers, and normalizers so OpenAI and future providers do not drift by surface.
6. Move console-only routing diagnostics into structured orchestration events where audit sinks can observe them.
