# Pipeline Architecture (`packages/agent/src/pipeline`)

## Scope
This module implements pipeline execution for `PipelineDefinition` graphs from `@dzupagent/core` and the supporting surfaces required to run, resume, inspect, and template those graphs.

Included in scope:
- Runtime execution engine: `pipeline-runtime.ts`
- Runtime contracts: `pipeline-runtime-types.ts`
- Runtime helper seams: `pipeline-runtime/*`
- Graph validation: `pipeline-validator.ts`
- Loop execution and predicate helpers: `loop-executor.ts`
- Retry policy utilities: `retry-policy.ts`
- Checkpoint stores: `in-memory-checkpoint-store.ts`, `postgres-checkpoint-store.ts`, `redis-checkpoint-store.ts`
- Built-in template factories: `pipeline-templates.ts`
- Run analytics aggregation: `pipeline-analytics.ts`
- Custom step-type extension registry: `step-type-registry.ts`

Out of scope:
- Canonical pipeline schema/type ownership (lives in `@dzupagent/core`)
- Application/product workflow authoring semantics (higher-level builders in `src/workflow` and app repos)

## Responsibilities
- Validate pipeline graph structure before execution.
- Execute node graphs with support for sequential, conditional, fork/join, loop, suspend, and approval-gate suspension behavior.
- Emit structured runtime lifecycle events through `onEvent`.
- Handle retries with per-node and global policy merging.
- Route failures through typed error edges and optional recovery-copilot integration.
- Persist and restore checkpoints using pluggable stores.
- Provide production-friendly helper stores for in-memory, Redis, and Postgres backends.
- Provide reusable template generators for common flows (review, feature gen, test gen, refactor).
- Aggregate run-level/node-level analytics and bottleneck signals.

## Structure
- `index.ts`
- `pipeline-runtime.ts`
- `pipeline-runtime-types.ts`
- `pipeline-runtime/edge-resolution.ts`
- `pipeline-runtime/checkpoint-helpers.ts`
- `pipeline-runtime/branch-merge.ts`
- `pipeline-runtime/runtime-events.ts`
- `pipeline-runtime/error-classification.ts`
- `pipeline-runtime/iteration-budget-tracker.ts`
- `pipeline-runtime/run-id.ts`
- `pipeline-runtime/state-utils.ts`
- `pipeline-validator.ts`
- `loop-executor.ts`
- `retry-policy.ts`
- `in-memory-checkpoint-store.ts`
- `postgres-checkpoint-store.ts`
- `redis-checkpoint-store.ts`
- `pipeline-templates.ts`
- `pipeline-analytics.ts`
- `step-type-registry.ts`
- `__tests__/error-classification.test.ts`
- `__tests__/step-type-registry.test.ts`

Related tests in `packages/agent/src/__tests__` cover runtime, retries, templates, validator, stores, and helper seams.

## Runtime and Control Flow
1. `PipelineRuntime.execute()` validates the definition with `validatePipeline`; invalid graphs throw before execution.
2. Runtime initializes run state (`runId`, mutable `state`, node result map, completed node list) and emits `pipeline:started`.
3. Main traversal (`executeFromNode`) walks from `entryNodeId` until no next node.
4. `suspend` nodes and `gate` nodes with `gateType === 'approval'` suspend immediately (`pipeline:suspended`) and save a checkpoint.
5. `fork` nodes execute branches in parallel until join boundary, then merge branch deltas/results.
6. `loop` nodes delegate iterative body execution to `executeLoop` and attach loop metrics to output.
7. Other node types run through injected `nodeExecutor` with retry, error-edge routing, and optional recovery handling.
8. Retry attempts are `node.retries + 1`; effective policy merges node-level and runtime-level policy via `resolveRetryPolicy`; backoff uses `calculateBackoff`; each retry emits `pipeline:node_retry`.
9. Error flow emits `pipeline:node_failed`, extracts/classifies error codes in `pipeline-runtime/error-classification.ts`, resolves code-aware error edges (`errorCodes`) then generic fallback, and finally attempts recovery copilot before failing the run.
10. Optional control hooks emit additional events: `stuckDetector` (`pipeline:stuck_detected`), `trajectoryCalibrator` (`pipeline:calibration_suboptimal`), and `iterationBudget` (`pipeline:iteration_budget_warning` at 70%/90%).
11. Successful traversal emits `pipeline:completed`; `resume(checkpoint, additionalState?)` restores state, seeds completed-node placeholders, and continues from the next node after `suspendedAtNodeId`.

## Key APIs and Types
Primary exports from `src/pipeline/index.ts`:
- Runtime/validation: `PipelineRuntime`, `validatePipeline`, `executeLoop`, `stateFieldTruthy`, `qualityBelow`, `hasErrors`
- Checkpoint stores: `InMemoryPipelineCheckpointStore`, `PostgresPipelineCheckpointStore` (+ `PostgresClientLike`, options type), `RedisPipelineCheckpointStore` (+ `RedisClientLike`, options type)
- Retry helpers: `DEFAULT_RETRY_POLICY`, `calculateBackoff`, `isRetryable`, `resolveRetryPolicy`
- Templates: `createCodeReviewPipeline`, `createFeatureGenerationPipeline`, `createTestGenerationPipeline`, `createRefactoringPipeline`
- Analytics: `PipelineAnalytics` and report metric types
- Extensibility: `StepTypeRegistry`, `defaultStepTypeRegistry`

Important runtime types (`pipeline-runtime-types.ts`):
- `PipelineRuntimeConfig`, `PipelineRuntimeEvent`, `PipelineRunResult`, `PipelineState`
- `NodeExecutor`, `NodeExecutionContext`, `NodeResult`
- `RetryPolicy`, `LoopMetrics`, `PipelineTracer`, `OTelSpanLike`

Note on package-root exports:
- `packages/agent/src/index.ts` re-exports most pipeline APIs, but does not currently re-export `PostgresPipelineCheckpointStore` or `RedisPipelineCheckpointStore`.
- Those two stores are exported from `src/pipeline/index.ts`.

## Dependencies
Internal package dependencies used by this module:
- `@dzupagent/core`
- `@dzupagent/agent-types`

Optional runtime integrations via config types/imports:
- Recovery integration types from `src/recovery/*`
- Stuck detector and trajectory calibrator types from `src/self-correction/*`

Storage clients are interface-driven, not hard-bound libraries:
- `PostgresClientLike` (`query(...)`) for pg-like clients
- `RedisClientLike` (`get/set/z* /s*`) for ioredis/node-redis-like clients

## Integration Points
Inside `packages/agent`:
- `src/workflow/workflow-builder.ts` compiles workflow DSL to `PipelineDefinition` and executes with `PipelineRuntime`.
- `src/self-correction/self-learning-runtime.ts` wraps `PipelineRuntime` and chains self-learning hooks/events.
- `src/index.ts` re-exports core pipeline runtime/validator/retry/template/analytics/step-registry APIs.

Cross-package references in this workspace:
- `packages/codegen/src/pipeline/pipeline-executor.ts` imports and uses `PipelineRuntime`.
- `packages/agent-adapters/src/workflow/adapter-workflow.ts` compiles adapter workflows to pipeline definitions and runs via `PipelineRuntime`.

## Testing and Observability
Pipeline surfaces are covered by focused suites in `packages/agent/src/__tests__` and `packages/agent/src/pipeline/__tests__`, including:
- Runtime control paths: `pipeline-runtime.test.ts`, `pipeline-runtime.cancel-timeout-retry.test.ts`
- Retry utilities/runtime retry behavior: `pipeline-retry.test.ts`
- Runtime helper seams and event builders: `pipeline-runtime-helpers.test.ts`
- Validation and templates: `pipeline-validator.test.ts`, `pipeline-templates.test.ts`
- Checkpoint stores/autowiring: `checkpoint-store.test.ts`, `redis-checkpoint-store.test.ts`, `postgres-checkpoint-store.test.ts`, `pipeline-checkpoint-autowire.test.ts`
- Analytics: `pipeline-analytics.test.ts`
- Loop branch coverage: `loop-executor-branches.test.ts`
- Pipeline-local helper units: `pipeline/__tests__/error-classification.test.ts`, `pipeline/__tests__/step-type-registry.test.ts`

Observability hooks exposed by runtime:
- Event stream via `PipelineRuntimeConfig.onEvent`
- OTel-style span hooks via `PipelineTracer`
- Structured event payload constructors in `pipeline-runtime/runtime-events.ts`

## Risks and TODOs
- Checkpoint strategy behavior is asymmetric today: `after_each_node` is honored in `saveCheckpoint`; `none` and `manual` skip per-node checkpointing; suspend/approval paths still save checkpoints regardless of strategy because `handleSuspend` writes directly when a store exists; `on_suspend` is not explicitly handled in `saveCheckpoint`.
- Package export split can cause adoption confusion: Postgres/Redis stores are exported from `src/pipeline/index.ts` but not from package root `src/index.ts`.
- `resume()` reconstructs completed node results as placeholders (`output: null`, `durationMs: 0`) rather than original outputs.
- Loop metrics include `terminationReason: 'budget_exceeded'` in type space, but current `executeLoop` logic does not emit that termination path.
- Run IDs are process-local (`run_${Date.now()}_${counter}`), not globally unique UUIDs.
- Branch execution currently continues/merges surviving branches even when one branch fails; this is intentional in current runtime but should be an explicit design decision for callers.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: refreshed content against current `packages/agent/src/pipeline` implementation, exports, and test layout.

