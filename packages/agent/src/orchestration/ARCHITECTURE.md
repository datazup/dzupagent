# Orchestration Architecture (`@dzupagent/agent`)

## Scope
This document describes the orchestration subsystem under `packages/agent/src/orchestration` in `@dzupagent/agent`.

Included modules:
- Core orchestration entrypoints: `orchestrator.ts`, `map-reduce.ts`, `merge-strategies.ts`, `orchestration-error.ts`, `index.ts`
- Delegation and planning: `delegation.ts`, `delegating-supervisor.ts`, `planning-agent.ts`
- Contract-net: `contract-net/*`
- Routing and merge policy layers: `routing/*`, `routing-policy-types.ts`, `merge/*`, `orchestration-merge-strategy-types.ts`
- Topology analysis/execution: `topology/*`
- Provider-adapter boundary: `provider-adapter/*`
- Team runtime: `team/*`
- Telemetry helpers and circuit breaker bridge: `orchestration-telemetry.ts`, `circuit-breaker.ts`

Out of scope:
- Generic agent loop internals (`src/agent/*`)
- Workflow and pipeline runtimes outside orchestration folder
- App-specific orchestration UI/state in downstream applications

## Responsibilities
The orchestration layer provides reusable multi-agent coordination primitives on top of `DzupAgent` and core runtime contracts.

Primary responsibilities:
- Execute common multi-agent patterns:
  - sequential (`AgentOrchestrator.sequential`)
  - parallel (`AgentOrchestrator.parallel`)
  - supervisor (`AgentOrchestrator.supervisor`)
  - debate (`AgentOrchestrator.debate`)
  - contract-net (`AgentOrchestrator.contractNet` / `ContractNetManager`)
- Support map-reduce style fan-out/fan-in with bounded concurrency and merge strategies.
- Provide typed delegation protocol (`DelegationRequest`/`DelegationResult`) with run tracking and lifecycle events.
- Plan and execute DAG-shaped work decomposition (`PlanningAgent`) with dependency validation and level-by-level execution.
- Route tasks to specialists through pluggable routing policies.
- Merge partial outcomes through pluggable merge strategies for timeout/error-tolerant orchestration.
- Recommend and execute topologies (`hierarchical`, `pipeline`, `star`, `mesh`, `ring`).
- Provide a dependency-inverted provider execution port for adapter-based execution paths.
- Provide a declarative `TeamRuntime` for pattern-based team execution plus phase/event tracing and supervision policy.

## Structure
Top-level orchestration layout:
- `index.ts`: barrel exports for the public orchestration surface (routing/merge strategy types and classes, contract-net, map-reduce, orchestrator, telemetry, circuit-breaker bridge).
- `orchestration-error.ts`: shared `OrchestrationError` tagged by `OrchestrationPattern`.
- `orchestrator.ts`: static high-level orchestration methods.
- `map-reduce.ts`: chunk/task fan-out with `Semaphore` from `@dzupagent/core/orchestration`.
- `merge-strategies.ts`: string merge helpers (`concat`, `vote`, `numbered`, `json`).
- `delegation.ts`: `SimpleDelegationTracker` backed by `RunStore` and optional `DzupEventBus`.
- `delegating-supervisor.ts`: specialist registry + delegation execution, optional routing/merge/circuit-breaker/provider-port integration.
- `planning-agent.ts`: DAG utilities (`buildExecutionLevels`, `validatePlanStructure`) plus LLM decomposition via structured output.

Subdirectories:
- `contract-net/`: CFP/bidding lifecycle manager, bid strategy implementations, protocol types.
- `routing/`: `RuleBasedRouting`, `HashRouting`, `RoundRobinRouting`, `LLMRouting`.
- `merge/`: `AllRequiredMergeStrategy`, `UsePartialMergeStrategy`, `FirstWinsMergeStrategy`.
- `topology/`: analyzer and executor for topology-based coordination.
- `provider-adapter/`: `ProviderExecutionPort` and result contract.
- `team/`: declarative team definitions/policies/phases/checkpoints plus `TeamRuntime`.

## Runtime and Control Flow
### 1) `AgentOrchestrator`
- `sequential`: passes previous output as the next input in a linear chain.
- `parallel`:
  - optional circuit-breaker filtering before fan-out
  - optional all-settled path with `OrchestrationMergeStrategy`
  - fallback merge function path (`MergeFn`) if strategy not provided
- `supervisor`:
  - supports legacy positional and config overloads
  - optional provider-adapter mode via `providerPort.run`
  - optional routing policy and circuit-breaker filtering
  - optional health check (`asTool()` probes)
  - injects specialist tools into a cloned manager `DzupAgent`
- `debate`: proposer rounds then judge synthesis/selection.
- `contractNet`: delegates to `ContractNetManager.execute`.

### 2) Delegation + Planning
- `SimpleDelegationTracker` flow:
  - create child run in `RunStore`
  - register active delegation
  - execute callback with `AbortController`
  - race completion against abort/timeout
  - persist terminal run status and emit lifecycle events
- `DelegatingSupervisor`:
  - `delegateTask` handles single specialist delegation (or provider-port execution)
  - `delegateAndCollect` executes all assignments via `Promise.allSettled`
  - optional merge strategy receives normalized `AgentResult[]`
  - `planAndDelegate` chooses LLM decomposition first, then keyword/routing fallback
- `PlanningAgent`:
  - validates DAG structure and specialist references
  - executes by `executionLevels`, chunked by `maxParallelism`
  - injects predecessor outputs into `_predecessorResults`
  - skips descendants of failed nodes

### 3) Contract-net
`ContractNetManager.execute` lifecycle:
- announce CFP
- collect bids (deadline enforced by abort-race)
- evaluate bids (default weighted strategy)
- award winner
- execute awarded task with winning specialist
- emit protocol events through `DzupEventBus` when provided

### 4) Topology
- `TopologyAnalyzer`: heuristic scoring over task characteristics.
- `TopologyExecutor`:
  - native mesh and ring execution paths
  - routed paths: pipeline -> sequential, star -> parallel, hierarchical -> supervisor
  - optional auto-switch retries with analyzer recommendation when observed error rate exceeds threshold

### 5) Team runtime
`TeamRuntime.execute`:
- creates run/phase model
- emits runtime events (`phase_changed`, participant/team completion/failure)
- dispatches by `TeamDefinition.coordinatorPattern`:
  - `supervisor`, `contract_net`, `blackboard`, `peer_to_peer`, `council`
- supports optional tracer hooks (`TeamRuntimeTracer`) and supervision policy circuit-breaking
- supports `resume()` based on `TeamCheckpoint` + `ResumeContract`

Important implementation note:
- `TeamRuntime` contains concrete orchestration skeletons and event/plumbing logic, but comments explicitly mark it as structural with higher-level model wiring expected from host product code.

## Key APIs and Types
Core classes/functions:
- `AgentOrchestrator`
- `mapReduce`, `mapReduceMulti`
- `ContractNetManager`
- `DelegatingSupervisor`
- `PlanningAgent`
- `SimpleDelegationTracker`
- `TopologyAnalyzer`, `TopologyExecutor`
- `TeamRuntime`

Core contracts:
- `SupervisorConfig`, `SupervisorResult`
- `MapReduceConfig`, `MapReduceResult`, `AgentOutput`
- `DelegationRequest`, `DelegationResult`, `DelegationTracker`
- `ExecutionPlan`, `PlanNode`, `PlanExecutionResult`
- `RoutingPolicy`, `RoutingDecision`, `AgentSpec`, `AgentTask`
- `OrchestrationMergeStrategy`, `AgentResult`, `MergedResult`
- `ContractNetConfig`, `ContractBid`, `ContractResult`
- `TopologyExecutorConfig`, `TopologyMetrics`, `TopologyRecommendation`
- `ProviderExecutionPort`, `ProviderExecutionResult`
- `TeamDefinition`, `TeamPolicies`, `TeamCheckpoint`, `ResumeContract`, `SupervisionPolicy`

Error model:
- `OrchestrationError` is the shared domain error with pattern tagging for diagnostics.

## Dependencies
Direct internal package dependencies used by orchestration code paths:
- `@dzupagent/core`
  - `RunStore`, `DzupEventBus` (delegation and protocol events)
  - `Semaphore` (map-reduce concurrency)
  - `KeyedCircuitBreaker` re-exported as `AgentCircuitBreaker`
- `@dzupagent/adapter-types`
  - provider adapter port input/output event/type contracts
- Structured output utilities in this package (`../structured/structured-output-engine`)
  - LLM decomposition schema generation in `PlanningAgent`
- `@langchain/core/messages`
  - `HumanMessage` for generation prompts
- `zod`
  - decomposition schema definitions (`PlanNodeSchema`, `DecompositionSchema`)

Package metadata context (`packages/agent/package.json`):
- Runtime deps include `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/adapter-types`, `@dzupagent/agent-types`.
- Peer deps include `@langchain/core`, `@langchain/langgraph`, `zod`.

## Integration Points
Within `@dzupagent/agent`:
- Root barrel (`src/index.ts`) re-exports the main orchestration API surface (orchestrator, map-reduce, planning/delegation, contract-net, topology, routing/merge policies, circuit-breaker bridge, provider port types).
- Team runtime types/module are maintained under `src/orchestration/team/*` and validated via focused team tests/benchmarks.

Cross-package and boundary integration:
- Provider adapters integrate through `ProviderExecutionPort` (inversion boundary; adapters implement the port externally).
- Delegation integrates with `RunStore` and `DzupEventBus` from `@dzupagent/core` rather than server-specific wiring.
- Contract-net emits protocol events through generic event bus payloads (`protocol:message_sent`) for downstream observers.

## Testing and Observability
Orchestration-focused automated tests in scope:
- `src/orchestration/__tests__/orchestration-paths.test.ts`
  - integration-style coverage for supervisor, parallel, contract-net, map-reduce, topology pipeline path, and planning DAG utilities
- `src/orchestration/__tests__/routing-policy.test.ts`
  - deterministic/edge behavior of rule/hash/round-robin/LLM routing wrappers
- `src/orchestration/__tests__/merge-strategy.test.ts`
- `src/orchestration/__tests__/merge-strategies-extended.test.ts`
  - merge semantics, edge cases, helper strategy lookup, and depth guard checks
- `src/orchestration/__tests__/circuit-breaker.test.ts`
  - legacy `AgentCircuitBreaker` behavior via core re-export
- `src/orchestration/team/__tests__/team-supervision-policy.spec.ts`
  - per-agent breaker trip/reset semantics in `TeamRuntime`
- `src/orchestration/team/__tests__/team-runtime-otel.test.ts`
  - span attributes/events and success/error completion hooks

Performance benchmark:
- `src/orchestration/team/__benches__/team-runtime.bench.ts`
  - concurrent runtime throughput with p95 latency assertion target.

Observability surfaces in code:
- `orchestration-telemetry.ts`: structured `console.debug` helpers for routing/merge/circuit-breaker events.
- `DelegatingSupervisor` + `SimpleDelegationTracker`: event-bus emissions for delegation and plan lifecycle events.
- `TeamRuntime`: typed event emitter plus tracer hooks (`startPhaseSpan`, `addEvent`, `endSpanOk`, `endSpanWithError`).

## Risks and TODOs
Current implementation risks/gaps visible in code:
- Planning result collision risk:
  - `DelegatingSupervisor.delegateAndCollect` stores results keyed by `specialistId`.
  - `PlanningAgent.executePlan` retrieves by `node.specialistId`.
  - Multiple same-specialist nodes in one execution chunk can overwrite each other.
- `MapReduceConfig.mergeStrategy` type union omits supported names (`numbered`, `json`) even though `getMergeStrategy` supports them.
- `AgentOrchestrator.supervisor` provider-adapter branch requires both `executionMode === 'provider-adapter'` and `providerPort`; missing port silently falls back to agent mode.
- `ContractNetConfig.manager` exists in contract type but manager instance is not currently used inside `ContractNetManager.execute` logic.
- `TopologyExecutor` routed-path metrics (`pipeline`, `star`, `hierarchical`) currently hardcode `errorCount: 0` unless errors throw, unlike mesh/ring which track per-agent failures.
- Team runtime pattern labels are not perfectly aligned with coordinator pattern names in all return paths (for example some paths return `'peer-to-peer'`/`'supervisor'` as pattern labels independent of coordinator enum shape).
- `orchestration-telemetry.ts` currently logs to debug output only; no direct OTel SDK binding in this module.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

