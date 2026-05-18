# Pipeline Architecture (`packages/agent/src/pipeline`)

## Scope
This document covers the pipeline runtime subsystem under `packages/agent/src/pipeline` and the package entrypoints that expose it (`src/pipeline.ts`, `src/runtime.ts`, and root `src/index.ts`).

In scope:
- Runtime lifecycle coordinator: `pipeline-runtime.ts`
- Graph traversal and node dispatch engine: `pipeline-executor.ts`
- Runtime contracts and config surface: `pipeline-runtime-types.ts`
- Runtime helper seams in `pipeline-runtime/*` (retry, error classification, branch execution/merge, loop handling, event builders, checkpoint helpers, run-id generation, budget tracking)
- Validation: `pipeline-validator.ts`
- Loop primitive and predicate helpers: `loop-executor.ts`
- Retry utilities: `retry-policy.ts`
- Checkpoint stores: in-memory, Redis, Postgres
- Built-in template factories: `pipeline-templates.ts`
- Analytics accumulator: `pipeline-analytics.ts`
- Extensible step registry: `step-type-registry.ts`

Out of scope:
- Canonical pipeline schema ownership (`@dzupagent/core/pipeline`)
- Canonical pure runtime contract shapes (`@dzupagent/runtime-contracts`)
- Workflow DSL authoring itself (`src/workflow/*`) beyond how it compiles/executes via this runtime

## Responsibilities
- Validate `PipelineDefinition` structure before execution.
- Execute pipeline graphs over a shared mutable state with support for:
  - Sequential and conditional routing
  - Error edges (including error-code matching)
  - Suspend nodes and approval gates
  - Fork/join branch fan-out and merge
  - Loop nodes with predicate-driven continuation
- Provide per-node retry with merged global/per-node retry policy and exponential backoff.
- Surface runtime lifecycle and telemetry events through `onEvent`.
- Support cancellation via `AbortSignal` and explicit `cancel()`.
- Persist and restore checkpoints through pluggable `PipelineCheckpointStore` implementations.
- Integrate optional runtime collaborators:
  - Stuck detector
  - Recovery copilot
  - Trajectory calibrator
  - Iteration-budget warning tracker
  - OTel-like tracer abstraction
- Provide reusable template pipelines and in-memory analytics rollups.
- Provide a typed registry for custom step kinds (schema-validated config/output).

## Structure
Primary files in `src/pipeline`:
- `pipeline-runtime.ts`: public runtime API (`execute`, `resume`, `cancel`, `getRunState`) and store autowiring.
- `pipeline-executor.ts`: traversal loop and per-node-type routing.
- `pipeline-runtime-types.ts`: runtime config/types, plus re-export shim of pure contracts from `@dzupagent/runtime-contracts`.
- `pipeline-validator.ts`: graph structural validation.
- `loop-executor.ts`: generic loop body execution + built-in predicates.
- `retry-policy.ts`: retry policy merge/backoff/retryable checks.
- `in-memory-checkpoint-store.ts`
- `redis-checkpoint-store.ts`
- `postgres-checkpoint-store.ts`
- `pipeline-templates.ts`
- `pipeline-analytics.ts`
- `step-type-registry.ts`
- `index.ts`: internal barrel used by `src/runtime.ts`.
- `ARCHITECTURE.md`

Runtime helper seams in `src/pipeline/pipeline-runtime`:
- `standard-node-dispatch.ts`
- `node-retry.ts`
- `node-side-effects.ts`
- `fork-branch-executor.ts`
- `branch-merge.ts`
- `loop-node-handler.ts`
- `edge-resolution.ts`
- `error-classification.ts`
- `checkpoint-helpers.ts`
- `iteration-budget-tracker.ts`
- `runtime-events.ts`
- `run-id.ts`
- `state-utils.ts`

Tests:
- Local helper-focused tests in `src/pipeline/__tests__`:
  - `error-classification.test.ts`
  - `step-type-registry.test.ts`
- Broader runtime/store/template/validator coverage in `src/__tests__` (pipeline-specific suites listed below).

## Runtime and Control Flow
1. `PipelineRuntime.execute(initialState?)` validates the definition using `validatePipeline`.
2. Runtime initializes run-scoped state:
  - `runId` from `generateRunId()`
  - mutable `runState`
  - `nodeResults` map
  - `completedNodeIds`
  - checkpoint `versionTracker`
  - lifecycle state `running`
3. Runtime delegates traversal to `PipelineExecutor.executeFromNode(...)`.
4. Executor loop behavior:
  - If cancelled (`cancel()` or aborted signal): returns `state: cancelled`.
  - Skips nodes already in `completedNodeIds` (resume support).
  - `suspend` and `gate` with `gateType === 'approval'` call `handleSuspend(...)`, emit suspend event, checkpoint, and return `state: suspended`.
  - `fork` nodes call `handleFork(...)`:
    - Collect branch starts from outgoing sequential/conditional edges.
    - Execute branches in parallel with branch-local cloned state/results.
    - Merge fulfilled branch state deltas and node results back in branch-order.
    - Failed branches emit `pipeline:node_failed` but do not abort surviving branches.
    - Continue after matching join node (if found).
  - `loop` nodes call `handleLoop(...)` which wraps `executeLoop(...)`, then routes success/error via normal or error-edge paths.
  - All other nodes use `dispatchStandardNode(...)`.
5. Standard-node dispatch (`standard-node-dispatch.ts`):
  - Emits node start event and optional span.
  - Executes node via `runNodeWithRetry(...)`.
  - On success:
    - Emits node completed event
    - Runs optional stuck-detector success hook
    - Runs optional trajectory calibration hook
    - Runs optional iteration-budget accounting/warning hook
    - Marks node complete and optionally checkpoints
    - Resolves next node from normal edges
  - On failure result or thrown error:
    - Emits node failed event
    - Runs optional stuck-detector failure hook
    - Attempts error-edge routing via extracted error code
    - Attempts recovery copilot when configured/eligible/budget-available
    - Falls back to failed run
6. Checkpoint strategy:
  - `saveCheckpoint(...)` currently writes only for `checkpointStrategy === 'after_each_node'`.
  - `none` and `manual` skip automatic per-node saves.
  - Suspend/approval paths still persist checkpoints directly in `handleSuspend(...)` if a store is configured.
7. Resume flow (`PipelineRuntime.resume(checkpoint, additionalState?)`):
  - Restores state from checkpoint + additional state.
  - Rebuilds completed-node placeholders in `nodeResults`.
  - Restores recovery-attempt counter from checkpoint.
  - Starts from the next node after `suspendedAtNodeId` based on current predicates/state.
  - Re-enters shared `runFromNode(...)` path.
8. Terminal events/results:
  - Completed: `pipeline:completed`
  - Failed: `pipeline:failed`
  - Suspended: `pipeline:suspended`
  - Cancelled: returns cancelled result without throwing

## Key APIs and Types
Public runtime class:
- `PipelineRuntime` (`pipeline-runtime.ts`)

Validation:
- `validatePipeline(definition)` (`pipeline-validator.ts`)

Loop utilities:
- `executeLoop(...)`
- `stateFieldTruthy(field)`
- `qualityBelow(field, threshold)`
- `hasErrors(field)`

Retry utilities:
- `DEFAULT_RETRY_POLICY`
- `calculateBackoff(attempt, policy?)`
- `isRetryable(error, policy?)`
- `resolveRetryPolicy(nodePolicy, globalPolicy)`

Checkpoint stores:
- `InMemoryPipelineCheckpointStore`
- `RedisPipelineCheckpointStore`
- `PostgresPipelineCheckpointStore`
- Client adapter types:
  - `RedisClientLike`
  - `PostgresClientLike`

Templates:
- `createCodeReviewPipeline`
- `createFeatureGenerationPipeline`
- `createTestGenerationPipeline`
- `createRefactoringPipeline`

Analytics:
- `PipelineAnalytics`
- `PipelineAnalyticsReport`, `NodeMetrics`, `BottleneckEntry`, `AnalyticsRunInput`

Step registry:
- `StepTypeRegistry`
- `defaultStepTypeRegistry`
- `StepTypeDescriptor`, `StepContext`

Core runtime type surface (`pipeline-runtime-types.ts`):
- Re-exported canonical contracts: `PipelineState`, `NodeResult`, `NodeExecutionContext`, `PipelineRunResult`, `PipelineRuntimeEvent`, `LoopMetrics`
- Agent-specific extensions:
  - `PipelineRuntimeConfig`
  - `RetryPolicy`
  - `PipelineTracer`, `OTelSpanLike`
  - `NodeExecutor` specialized to `PipelineNode`

Export barrels and differences:
- `src/pipeline.ts` (used for package export `@dzupagent/agent/pipeline`) exports runtime + stores + retry + templates + analytics + step registry.
- `src/index.ts` (package root `@dzupagent/agent`) exports most pipeline APIs, but does not export Redis/Postgres checkpoint stores.
- `src/runtime.ts` re-exports `./pipeline/index.js`, which currently does not include retry-policy helpers or analytics exports.

## Dependencies
Direct internal package dependencies used in this subsystem:
- `@dzupagent/core` (pipeline types, checkpoint store contracts, backoff helper)
- `@dzupagent/runtime-contracts` (canonical pure runtime contracts)
- `@dzupagent/agent-types` (canonical retry policy base shape)

Local cross-module dependencies:
- `src/recovery/*` for recovery copilot/failure typing
- `src/self-correction/*` for stuck detection and trajectory calibration
- `src/utils/exact-optional.ts` for omit-undefined shaping

Storage adapters are interface-based (no hard runtime dependency on specific client libraries):
- Redis-like client implementing required command subset
- Postgres-like client implementing `query(text, params?)`

## Integration Points
Within `@dzupagent/agent`:
- `src/workflow/compiled-workflow.ts` compiles workflow nodes to `PipelineDefinition` and executes/resumes through `PipelineRuntime`.
- `src/workflow/workflow-compiler.ts` stamps compiled metadata with runtime ownership (`PipelineRuntime`).
- `src/self-correction/self-learning-runtime.ts` wraps `PipelineRuntime`, composing stuck detection, enrichment hooks, trajectory/post-run analysis, and optional recovery copilot wiring.
- `src/runtime.ts` re-exports pipeline barrel (`src/pipeline/index.ts`) for runtime-focused consumers.
- Root `src/index.ts` exposes pipeline APIs through package root barrel.

Cross-package in this monorepo:
- `packages/agent-adapters/src/workflow/default-pipeline-executor.ts` imports `PipelineRuntime` from `@dzupagent/agent/pipeline`.
- `packages/agent-adapters` workflow layer treats runtime execution through adapter contracts while relying on the canonical runtime behavior.
- `packages/runtime-contracts` holds the canonical event/result/context type contracts that `pipeline-runtime-types.ts` re-exports for BC.

## Testing and Observability
Pipeline runtime behavior is covered by dedicated suites in `src/__tests__`:
- Runtime traversal/lifecycle: `pipeline-runtime.test.ts`
- Retry/cancel/timeout edge cases: `pipeline-retry.test.ts`, `pipeline-runtime.cancel-timeout-retry.test.ts`
- Store autowiring: `pipeline-checkpoint-autowire.test.ts`
- Validator and templates: `pipeline-validator.test.ts`, `pipeline-templates.test.ts`
- Analytics: `pipeline-analytics.test.ts`
- OTel tracer integration: `pipeline-otel.test.ts`
- Checkpoint stores: `checkpoint-store.test.ts`, `redis-checkpoint-store.test.ts`, `postgres-checkpoint-store.test.ts`
- Loop branch coverage: `loop-executor-branches.test.ts`

Pipeline-local helper unit suites in `src/pipeline/__tests__`:
- `error-classification.test.ts`
- `step-type-registry.test.ts`

Observability hooks:
- Event callback (`PipelineRuntimeConfig.onEvent`) emitting `PipelineRuntimeEvent` variants.
- OTel-style tracer interface (`PipelineTracer`) with per-node spans and fork/branch span support.
- Structured event constructors in `pipeline-runtime/runtime-events.ts`.
- Iteration-budget warning events and calibration/stuck/recovery events are surfaced as first-class runtime events.

## Risks and TODOs
- Checkpoint strategy support is intentionally partial:
  - Per-node saves are implemented only for `after_each_node`.
  - `on_suspend` is not handled in `saveCheckpoint(...)`.
  - Suspend/approval still checkpoint regardless of strategy because `handleSuspend(...)` persists directly.
- Run ID generation (`run_${Date.now()}_${counter}`) is process-local and not globally unique.
- Resume reconstructs completed node results as placeholders (`output: null`, `durationMs: 0`) rather than restoring historical outputs.
- Fork behavior is non-fail-fast: branch failures emit `node_failed` but do not automatically fail sibling branches or the fork unless downstream logic does.
- `LoopMetrics` type includes `terminationReason: 'budget_exceeded'`, but `executeLoop(...)` currently emits `condition_met`, `max_iterations`, or `cancelled`.
- Export surface can be confusing across entrypoints:
  - `@dzupagent/agent/pipeline` includes retry and analytics exports.
  - `@dzupagent/agent/runtime` re-exports `src/pipeline/index.ts`, which omits retry-policy and analytics exports.
  - Root package omits Redis/Postgres checkpoint stores.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewritten against current `packages/agent/src/pipeline` implementation, helper seams, entrypoint barrels, and test layout.

