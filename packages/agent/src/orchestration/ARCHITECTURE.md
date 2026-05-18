# Orchestration Architecture

## Scope
This document describes the current orchestration subsystem in `packages/agent/src/orchestration` within `@dzupagent/agent`.

Included code surface:
- Public orchestration entry points:
  - `src/orchestration/index.ts`
  - `src/orchestration.ts` (package subpath export)
  - `src/index.ts` (root re-exports)
- Core orchestration runtime:
  - `orchestrator.ts`
  - `supervisor-runner.ts`
  - `concurrency-runner.ts`
  - `orchestration-error.ts`
  - `orchestration-telemetry.ts`
  - `circuit-breaker.ts` and `circuit-breaker-recorder.ts`
  - `parallel-orchestration-results.ts`
- Delegation and planning:
  - `delegation.ts`
  - `delegating-supervisor.ts`
  - `delegating-supervisor-types.ts`
  - `parallel-delegation-aggregator.ts`
  - `assignment-validator.ts`
  - `specialist-selection.ts`
  - `planning-agent.ts`, `planning-decomposition.ts`, `planning-graph.ts`, `planning-executor.ts`, `planning-types.ts`
- Pattern modules:
  - `map-reduce.ts`
  - `merge-strategies.ts`
  - `merge/*`
  - `contract-net/*`
  - `routing/*` and `routing-policy-types.ts`
  - `topology/*`
  - `team/*` and `team/patterns/*`
- Compatibility/type shims:
  - `provider-adapter/provider-execution-port.ts`
  - `provider-adapter/index.ts`
- Test and benchmark coverage under:
  - `src/orchestration/__tests__/*`
  - `src/orchestration/topology/__tests__/*`
  - `src/orchestration/team/__tests__/*`
  - `src/orchestration/team/patterns/__tests__/*`
  - `src/orchestration/team/__benches__/team-runtime.bench.ts`

Out of scope:
- Agent core loop internals under `src/agent/*` except integration points consumed by orchestration.
- Workflow builder internals under `src/workflow/*`.
- App-level orchestration behavior outside this package.

## Responsibilities
The orchestration package provides reusable coordination primitives around `DzupAgent` instances.

Current responsibilities:
- Multi-agent orchestration façade via `AgentOrchestrator`:
  - `sequential`
  - `parallel` (with optional max concurrency, circuit breaker filtering, and typed merge strategy)
  - `supervisor` (agent mode and provider-adapter mode)
  - `debate`
  - `contractNet`
- Supervisor execution runtime:
  - Specialist tool injection via `asTool()`.
  - Optional routing-policy filtering and circuit-breaker filtering.
  - Optional specialist health checks.
  - Manager-with-tools caching keyed by manager instance + specialist set.
- Delegation protocol and tracking:
  - Typed request/result contracts.
  - RunStore-backed lifecycle tracking with timeout/cancel handling.
  - Parallel delegation aggregation and optional merge-strategy hooks.
  - Duplicate-specialist assignment guard for stable assignment IDs.
- Planning decomposition and execution:
  - LLM-driven decomposition into a DAG (`generateStructured` + Zod schema).
  - Deterministic refinement for unknown specialists / dangling dependencies.
  - Level-by-level execution with bounded parallelism and dependency skip propagation.
- Alternative coordination patterns:
  - Contract-net bidding and award flow.
  - Topology recommendation/execution (`hierarchical`, `pipeline`, `star`, `mesh`, `ring`) with optional auto-switch retry.
  - Team runtime with pattern registry (`supervisor`, `contract_net`, `blackboard`, `peer_to_peer`, `council`), lifecycle phases, policy validation, breaker supervision, event hooks, and resume flow.
- Merge and routing utilities:
  - String merge helpers (`concat`, `vote`, `numbered`, `json`).
  - Typed orchestration merge strategies (`all-required`, `use-partial`, `first-wins`).
  - Routing policies (`rule-based`, `hash`, `llm`, `round-robin`).
- Compatibility exports:
  - Legacy circuit breaker path (re-export from `@dzupagent/core/llm`).
  - Legacy provider adapter path (type re-export from `@dzupagent/adapter-types`).

## Structure
Top-level layout in `src/orchestration`:

- Core façade and shared primitives:
  - `orchestrator.ts`: static façade for main patterns.
  - `supervisor-types.ts`: config/result contracts for supervisor mode.
  - `supervisor-runner.ts`: concrete supervisor execution path.
  - `orchestration-error.ts`: typed orchestration error class and pattern labels.
  - `concurrency-runner.ts`: bounded/unbounded concurrent task helpers.
  - `orchestration-telemetry.ts`: logger-based structured telemetry helpers.

- Parallel and merge support:
  - `parallel-orchestration-results.ts`: `Promise.allSettled` normalization and merged-output rendering.
  - `merge-strategies.ts`: basic string merge functions.
  - `orchestration-merge-strategy-types.ts`: typed parallel result contract.
  - `merge/all-required.ts`, `merge/use-partial.ts`, `merge/first-wins.ts`: typed merge strategy implementations.

- Supervisor delegation stack:
  - `delegating-supervisor.ts`: supervisor wrapper around tracker/provider/routing/circuit-breaker.
  - `delegating-supervisor-types.ts`: configuration and plan/delegate contracts.
  - `delegation.ts`: typed protocol and `SimpleDelegationTracker`.
  - `parallel-delegation-aggregator.ts`: settled-result aggregation.
  - `assignment-validator.ts`: duplicate-specialist ID guard.
  - `specialist-selection.ts`: goal decomposition + matching/routing helpers.
  - `specialist-tool-instrumentation.ts`: wrapper to record breaker outcomes around tool calls.

- Planning:
  - `planning-types.ts`: core plan and diagnostics types.
  - `planning-decomposition.ts`: Zod schemas and decomposition/refinement.
  - `planning-graph.ts`: DAG level building and validation.
  - `planning-executor.ts`: plan execution engine.
  - `planning-agent.ts`: thin orchestrator API around above modules.

- Contract-net:
  - `contract-net/contract-net-manager.ts`: full CFP-bid-award-execute lifecycle.
  - `contract-net/contract-net-types.ts`: protocol state and payload contracts.
  - `contract-net/bid-strategies.ts`: ranking strategies.

- Routing:
  - `routing-policy-types.ts`: routing contracts.
  - `routing/rule-based-routing.ts`, `routing/hash-routing.ts`, `routing/llm-routing.ts`, `routing/round-robin-routing.ts`.

- Topology:
  - `topology/topology-types.ts`: topology contracts.
  - `topology/topology-analyzer.ts`: heuristic recommendation engine.
  - `topology/topology-executor.ts`: topology execution + optional auto-switch.

- Team runtime:
  - Core runtime and helpers:
    - `team/team-runtime.ts`
    - `team/team-runtime-execute.ts`
    - `team/team-runtime-resume.ts`
    - `team/team-runtime-policy-validator.ts`
    - `team/team-runtime-breaker.ts`
    - `team/team-runtime-hooks.ts`
    - `team/team-runtime-memory.ts`
    - `team/team-runtime-phase.ts`
    - `team/team-runtime-events.ts`
    - `team/team-workspace.ts`
  - Declarative contracts:
    - `team/team-definition.ts`
    - `team/team-policy.ts`
    - `team/team-checkpoint.ts`
    - `team/team-phase.ts`
    - `team/supervision-policy.ts`
  - Pattern implementations and registry:
    - `team/patterns/index.ts`
    - `team/patterns/supervisor-pattern.ts`
    - `team/patterns/contract-net-pattern.ts`
    - `team/patterns/blackboard-pattern.ts`
    - `team/patterns/peer-to-peer-pattern.ts`
    - `team/patterns/council-pattern.ts`
    - `team/patterns/pattern-utils.ts`
    - `team/patterns/team-pattern.ts`

- Compatibility shims:
  - `circuit-breaker.ts` (deprecated re-export alias).
  - `provider-adapter/provider-execution-port.ts` (type-only shim).

## Runtime and Control Flow
### 1. `AgentOrchestrator`
- `sequential(agents, initialInput)`:
  - Passes each agent the prior output (`HumanMessage` chain).
- `parallel(agents, input, merge?, options?)`:
  - Optional circuit-breaker filtering first.
  - If merge strategy or breaker is enabled, runs `runConcurrently` and all-settled normalization.
  - Records breaker outcomes (`recordSuccess`, `recordFailure`/`recordTimeout`).
  - Applies typed `OrchestrationMergeStrategy` when provided, otherwise legacy merge behavior.
  - When no breaker/typed merge is enabled, uses `runAllConcurrently` (reject-on-first-error semantics).
- `supervisor(...)`:
  - Accepts config-object form and deprecated positional overload.
  - Delegates execution to `runSupervisor`.
- `debate(proposers, judge, task, rounds?)`:
  - Runs proposer rounds, then asks judge to evaluate/synthesize.
- `contractNet(config)`:
  - Directly delegates to `ContractNetManager.execute`.

### 2. Supervisor runner (`runSupervisor`)
- Supports two execution modes:
  - `executionMode: 'provider-adapter'`: requires `providerPort` and executes through adapter port.
  - Default agent mode: builds/uses manager-with-tools `DzupAgent`.
- Agent mode pipeline:
  - Validate specialists and abort signal.
  - Optional circuit-breaker filtering + routing diagnostics event emission.
  - Optional routing policy narrowing.
  - Optional health check via `specialist.asTool()`.
  - Build specialist tools (instrumented for breaker recording when breaker exists).
  - Cache manager-with-tools agent per manager identity + canonical specialist set.
  - Run manager with task prompt and return content + specialist visibility info.

### 3. Delegation and planning
- `SimpleDelegationTracker`:
  - Creates run records in `RunStore`, tracks active delegations, handles timeout/cancellation via `AbortController`, updates run status/output, emits lifecycle events.
- `DelegatingSupervisor.delegateTask`:
  - Validates specialist, emits start event, then executes through provider port or delegation tracker.
  - Records circuit-breaker outcomes and completion events.
- `DelegatingSupervisor.delegateAndCollect`:
  - Optional breaker-based task filtering.
  - Duplicate-specialist assignment guard (`allow|warn|strict`).
  - Parallel `Promise.allSettled` + aggregation (`aggregateSettledResults`).
- `DelegatingSupervisor.planAndDelegate`:
  - If `llm` provided: uses `PlanningAgent.decompose` + `executePlan`.
  - On planning failure: emits fallback event and falls back to keyword/routing-policy assignment.
- `PlanningAgent` flow:
  - `decompose` calls structured-output decomposition (`PlanNodeSchema`/`DecompositionSchema`) and deterministic refinement.
  - `executePlan` validates and executes per DAG levels, injecting `_predecessorResults`, and marking downstream nodes skipped after failures.

### 4. Contract-net
`ContractNetManager.execute` lifecycle:
1. Validate config (`manager` key is explicitly rejected).
2. Build CFP and emit `contract-net:cfp_announced` protocol message.
3. Collect bids in parallel with per-bid deadlines.
4. Optional single retry when `retryOnNoBids` is true.
5. Evaluate bids using strategy (default weighted strategy).
6. Award winner and emit `contract-net:awarded`.
7. Execute task with winning specialist.
8. Emit completion/failure events and return `ContractResult`.

### 5. Topology execution
- `TopologyExecutor.execute({ topology, ... })` dispatches:
  - `mesh`: one-round all-settled fan-out.
  - `ring`: round-based iterative pass (`maxRounds`, default `3`).
  - `pipeline`: delegates to `AgentOrchestrator.sequential`.
  - `star`: delegates to `AgentOrchestrator.parallel`.
  - `hierarchical`: first agent is coordinator; remainder are workers via supervisor mode.
- `autoSwitch` path:
  - If initial topology fails or crosses error-rate threshold, analyzer recommends an alternative and executor retries once.

### 6. Team runtime
- Constructor validates policy support matrix and optionally enables supervision breaker tracking.
- `execute(task)` pipeline:
  - Creates run ID and phase model.
  - Starts optional OTel span and emits lifecycle transitions.
  - Short-circuits if all participant breakers are open.
  - Resolves participants, builds per-run context (`SharedWorkspace`, hooks, breaker registry), dispatches to selected pattern.
  - Runs optional post-run memory consolidation.
  - Emits completion or failure events.
- `resume(checkpoint, contract, task)`:
  - Validates team identity.
  - Narrows participants via `pendingParticipantIds` when `skipCompletedParticipants` is enabled.
  - Augments task with serialized shared context.
  - Reuses normal execute path with narrowed participants.

## Key APIs and Types
Primary orchestration APIs:
- `AgentOrchestrator`
- `ContractNetManager`
- `DelegatingSupervisor`
- `PlanningAgent`
- `SimpleDelegationTracker`
- `TopologyAnalyzer`
- `TopologyExecutor`
- `TeamRuntime`
- `mapReduce`, `mapReduceMulti`

Supervisor and delegation contracts:
- `SupervisorConfig`, `SupervisorResult`, `MergeFn`
- `DelegatingSupervisorConfig`, `TaskAssignment`, `AggregatedDelegationResult`, `PlanAndDelegateOptions`, `DelegateTaskOptions`
- `DelegationRequest`, `DelegationContext`, `DelegationResult`, `DelegationMetadata`, `DelegationTracker`, `DelegationExecutor`, `ActiveDelegation`
- `DuplicateSpecialistAssignmentIdMode`
- `MAX_ORCHESTRATION_DEPTH`, `assertDepthAllowed`

Planning contracts:
- `PlanNode`, `ExecutionPlan`, `PlanExecutionResult`
- `PlanningAgentConfig`, `PlanningSupervisor`
- `DecompositionSchema`, `PlanNodeSchema`, `DecompositionResult`
- `PlanningDecompositionDiagnostics`, `RemovedPlanNodeDiagnostic`, `DanglingPlanDependencyDiagnostic`
- `buildExecutionLevels`, `validatePlanStructure`

Routing and merge contracts:
- `RoutingPolicy`, `RoutingDecision`, `RoutingDiagnostics`, `AgentSpec`, `AgentTask`
- `LLMRoutingConfig`, `RuleBasedRoutingConfig`, `HashRoutingConfig`
- `AgentResult`, `MergedResult`, `OrchestrationMergeStrategy`, `BuiltInMergeStrategyName`
- `AllRequiredMergeStrategy`, `UsePartialMergeStrategy`, `FirstWinsMergeStrategy`
- `MergeStrategyFn`, `MergeStrategyName`, `concatMerge`, `voteMerge`, `numberedMerge`, `jsonArrayMerge`

Contract-net contracts:
- `ContractNetConfig`, `ContractNetPhase`, `ContractNetState`
- `CallForProposals`, `ContractBid`, `ContractAward`, `ContractResult`
- `BidEvaluationStrategy`, `lowestCostStrategy`, `fastestStrategy`, `highestQualityStrategy`, `createWeightedStrategy`

Topology contracts:
- `TopologyType`, `TaskCharacteristics`, `TopologyRecommendation`, `TopologyMetrics`, `TopologyExecutorConfig`
- `MeshResult`, `RingResult`, `ExecuteResult`

Team runtime contracts:
- `TeamDefinition`, `ParticipantDefinition`, `CoordinatorPattern`
- `TeamPolicies` and policy group types (`ExecutionPolicy`, `GovernancePolicy`, `MemoryPolicy`, `IsolationPolicy`, `MailboxPolicy`, `EvaluationPolicy`)
- `TeamPhase`, `TeamPhaseModel`
- `TeamCheckpoint`, `ResumeContract`
- `SupervisionPolicy`, `AgentBreakerState`
- `TeamRuntimeEvent`, `TeamRuntimeEventEmitter`
- `SharedWorkspace`, `TeamRunResult`, `TeamAgentRunResult`, `TeamSpawnedAgent`

## Dependencies
External/runtime dependencies used directly by orchestration modules:
- `@langchain/core`
  - `HumanMessage` for prompting
  - `StructuredToolInterface` for supervisor tool instrumentation
- `@dzupagent/core`
  - `llm` (`KeyedCircuitBreaker` via compatibility alias)
  - `events` (`DzupEventBus`, `typedEmit`)
  - `persistence` (`RunStore`, `AgentExecutionSpec`)
  - `orchestration` (`Semaphore` for map-reduce)
  - `utils` (`defaultLogger`)
- `@dzupagent/agent-types`
  - Base contracts for supervisor/map-reduce/contract-net/team coordination types
- `@dzupagent/adapter-types`
  - Canonical provider execution port types (re-exported by orchestration shim)
- `@dzupagent/memory`
  - `ConsolidationEngine` used by team post-run consolidation path
- `zod`
  - Plan decomposition schemas

Internal package dependencies within `@dzupagent/agent`:
- `DzupAgent` (`src/agent/dzip-agent.ts`) for execution and tool conversion.
- Structured output engine (`src/structured/structured-output-engine.ts`) for LLM plan decomposition.
- Utility helpers (`src/utils/exact-optional.ts`) for optional-field shaping.

## Integration Points
Orchestration integrates with the rest of the package and host systems through these contracts:

- Agent execution and tools:
  - Calls `DzupAgent.generate(...)` across all orchestration patterns.
  - Uses `DzupAgent.asTool()` to inject specialists into supervisor manager agents.

- Provider adapter execution:
  - `ProviderExecutionPort.run(...)` is used in:
    - `runSupervisor` when `executionMode: 'provider-adapter'`
    - `DelegatingSupervisor.delegateTask` when `providerPort` is configured

- Persistence and run lifecycle:
  - `SimpleDelegationTracker` creates/updates run records through `RunStore`.

- Eventing:
  - Delegation, routing, merge, and team lifecycle events are emitted through `DzupEventBus` and typed team runtime callbacks.
  - Contract-net emits protocol messages via `protocol:message_sent`.

- Circuit-breaker supervision:
  - Pattern-level filtering and failure recording via `AgentCircuitBreaker`/`KeyedCircuitBreaker`.
  - Team-level breaker policy wrapped by `TeamBreakerTracker`.

- Structured planning:
  - `PlanningAgent.decompose` calls `generateStructured(...)` with `DecompositionSchema`.

- Team memory lifecycle:
  - Optional post-run consolidation via a host-provided `memory.consolidate(...)` callback or `ConsolidationStore`.

## Testing and Observability
Test coverage inside scope currently includes:

- Core orchestration tests (`src/orchestration/__tests__`):
  - `orchestration-paths.test.ts`: end-to-end happy paths across supervisor, parallel merge, contract-net, map-reduce, topology pipeline, and planning DAG.
  - `merge-strategy.test.ts` and `merge-strategies-extended.test.ts`: typed merge behavior, helper merge functions, edge cases (empty inputs, timeout/error splits), and depth guard checks.
  - `routing-policy.test.ts`: rule/hash/round-robin/LLM routing behavior and fallback semantics.
  - `circuit-breaker.test.ts`: breaker state transitions and filtering behavior.

- Topology tests:
  - `topology/topology-executor-auto-switch.test.ts`: thrown-path and auto-switch behavior.

- Team runtime tests:
  - `team/__tests__/team-runtime-policy.test.ts`: policy enforcement and blackboard memory bounds.
  - `team/__tests__/team-runtime-otel.test.ts`: tracing attributes/events and success/failure span handling.
  - `team/__tests__/team-runtime-pattern-labels.test.ts`: result labeling.
  - `team/__tests__/team-supervision-policy.spec.ts`: supervision breaker open/reset/callback behavior.
  - `team/__tests__/team-workspace-contracts.test.ts`: workspace and result contracts.
  - Pattern-specific suites under `team/patterns/__tests__/*`.

- Benchmarks:
  - `team/__benches__/team-runtime.bench.ts` for runtime performance profiling.

Observability mechanisms in code:
- Structured debug telemetry helpers in `orchestration-telemetry.ts`.
- Supervisor routing and merge events via event bus.
- Team lifecycle events (`phase_changed`, `participant_*`, `team_*`, `policy_applied`, `team_consolidation_completed`).
- Optional OTel span integration in team runtime execution/hooks.

## Risks and TODOs
Current codebase risks and known gaps (from implementation and tests):

- Compatibility shims still carry legacy API surface:
  - `circuit-breaker.ts` is deprecated and aliases `KeyedCircuitBreaker` as `AgentCircuitBreaker`.
  - `provider-adapter/provider-execution-port.ts` is a historical type re-export.

- Team policy support is intentionally partial and fail-closed:
  - Unsupported today: `execution.timeoutMs`, `execution.retryOnFailure`, `execution.maxRetries`, all `isolation`, `mailbox`, and `evaluation` groups, plus governance `minScore` and `requireUnanimous`.

- `DelegatingSupervisor.planAndDelegate` silently falls back to keyword decomposition after LLM planning errors; this preserves availability but can mask decomposition quality regressions unless event streams are monitored.

- Supervisor agent cache in `supervisor-runner.ts` is process-memory-only and requires explicit invalidation via `AgentOrchestrator.clearSupervisorCache()` when manager/specialist configurations drift.

- Contract-net bid parsing relies on JSON text extraction from model output; malformed responses degrade into missing bids.

- Topology auto-switch uses static inferred characteristics on retry (`inferCharacteristics`) rather than measured run metrics, so retry choice is heuristic and not feedback-driven.

- Documentation drift exists in inline comments:
  - `team-policy.ts` comments state `consolidateOnComplete` is rejected, but runtime/tests show it is accepted and executed when memory hooks are configured.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js