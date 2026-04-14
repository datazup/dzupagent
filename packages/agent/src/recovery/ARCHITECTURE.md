# Recovery Module Architecture (`packages/agent/src/recovery`)

## Scope

This folder implements the `@dzupagent/agent` recovery stack used to:

- classify and fingerprint failures
- generate and rank candidate recovery strategies
- execute selected strategies with optional human approval
- provide a one-call copilot (`recover`) that can learn from past outcomes

Primary files:

- [`failure-analyzer.ts`](./failure-analyzer.ts)
- [`strategy-ranker.ts`](./strategy-ranker.ts)
- [`recovery-executor.ts`](./recovery-executor.ts)
- [`recovery-copilot.ts`](./recovery-copilot.ts)
- [`recovery-types.ts`](./recovery-types.ts)
- [`index.ts`](./index.ts)

Exported publicly via:

- [`packages/agent/src/index.ts`](../index.ts)

## Design Summary

The module is split into four focused components:

- `FailureAnalyzer`: pattern-based error classification + deterministic fingerprinting + in-memory recurrence history.
- `StrategyRanker`: weighted ranking based on confidence, risk, and estimated step cost, with attempt penalties.
- `RecoveryExecutor`: action runner with high-risk approval gate integration and lifecycle event emission.
- `RecoveryCopilot`: orchestration layer that creates plans, executes plans, tracks plan history, and optionally uses `RecoveryFeedback`.

`RecoveryCopilot` is compositional:

- it does not know how to execute actions itself
- it delegates action execution to a user-supplied `ActionHandler`
- it delegates persistence-based learning to optional `RecoveryFeedback`

## Core Data Model

Defined in [`recovery-types.ts`](./recovery-types.ts):

- `FailureType`
  - `build_failure`, `generation_failure`, `test_failure`, `timeout`, `resource_exhaustion`
- `FailureContext`
  - normalized context for any failure event (`runId`, `nodeId`, `error`, `timestamp`, `previousAttempts`)
- `RecoveryAction`
  - atomic step (`retry`, `rollback`, `skip`, `modify_params`, `fallback_model`, `reduce_scope`, `human_escalation`)
- `RecoveryStrategy`
  - ordered list of actions plus metadata (`confidence`, `risk`, `estimatedSteps`)
- `RecoveryPlan`
  - plan envelope (`status`, `selectedStrategy`, timestamps, executionError)
- `RecoveryResult`
  - standardized execution result (`success`, `summary`, `durationMs`)

## End-to-End Flow

## 1) Plan Creation (`RecoveryCopilot.createPlan`)

1. Guard max attempts (`previousAttempts >= maxAttempts` -> immediate escalation plan).
2. Analyze failure via `FailureAnalyzer.analyze`.
3. Generate strategies (`strategyGenerator`, default or custom).
4. Optionally adjust confidence from past lessons (`applyLessonBoosts`).
5. Apply `maxStrategies` cap.
6. Rank via `StrategyRanker.rank`.
7. Select best strategy via `StrategyRanker.selectBest(minAutoExecuteConfidence)`.
8. Persist plan in in-memory map and emit event (`agent:stuck_detected` with recovery metadata).

## 2) Plan Execution (`RecoveryExecutor.execute`)

1. Validate selected strategy exists.
2. If strategy is high-risk and approval is required, call `ApprovalGate.waitForApproval`.
3. If dry-run mode is enabled, mark completed without running actions.
4. Execute actions sequentially using `ActionHandler`.
5. On first action failure, stop immediately, mark plan failed, return error summary.
6. On success, mark plan completed and return success summary.
7. Emit lifecycle/action events through event bus.

## 3) One-Shot Recovery (`RecoveryCopilot.recover`)

1. Analyze failure.
2. If `RecoveryFeedback` is configured, retrieve similar lessons.
3. Create plan (with lesson-informed confidence adjustments).
4. If escalated plan returned (max attempts), exit early.
5. Execute plan.
6. Record outcome in analyzer + mark attempted strategy.
7. Best-effort write lesson through `RecoveryFeedback`.

## 4) Pipeline Runtime Integration

`PipelineRuntime` calls recovery when node execution fails and no error edge handled it:

- [`packages/agent/src/pipeline/pipeline-runtime.ts`](../pipeline/pipeline-runtime.ts)
  - builds `FailureContext`
  - emits `pipeline:recovery_attempted|succeeded|failed`
  - retries the failed node if `recover()` returns success

Recovery-related runtime config is defined in:

- [`packages/agent/src/pipeline/pipeline-runtime-types.ts`](../pipeline/pipeline-runtime-types.ts)

## Feature Matrix

| Feature | Component | Behavior |
|---|---|---|
| Error classification | `FailureAnalyzer` | Regex-based mapping of raw errors to `FailureType`. |
| Recurrence detection | `FailureAnalyzer` | Fingerprint map tracks count + prior resolutions. |
| Structured extraction | `FailureAnalyzer` | Extracts file, line, HTTP status, module hints from error text. |
| Strategy scoring | `StrategyRanker` | Composite score: confidence + risk + inverse cost. |
| Attempt-aware ranking | `StrategyRanker` | Heavily penalizes previously attempted strategies. |
| High-risk approval | `RecoveryExecutor` | Blocks execution until `ApprovalGate` returns approved. |
| Dry-run mode | `RecoveryExecutor` | Validates path and emits events, no action execution. |
| Sequential action execution | `RecoveryExecutor` | Stops at first failed action; returns deterministic summary. |
| Orchestration | `RecoveryCopilot` | create plan -> execute -> history update -> optional feedback write. |
| Stuck detector bridge | `RecoveryCopilot.handleStuckSignal` | Converts stuck status to `FailureContext` and creates plan. |
| Learning loop | `RecoveryCopilot` + `RecoveryFeedback` | Uses past lessons to boost/penalize strategy confidence. |

## Default Strategy Catalog

Built in [`recovery-copilot.ts`](./recovery-copilot.ts) by `defaultStrategyGenerator`:

- `build_failure`
  - `retry_with_fix_prompt`
  - `reduce_scope`
- `test_failure`
  - `retry_with_test_context`
  - `skip_failing_tests`
- `timeout`
  - `retry_with_smaller_scope`
  - `simple_retry`
- `resource_exhaustion`
  - `fallback_to_cheaper_model`
  - `reduce_scope_and_retry`
- `generation_failure`
  - `simple_retry`
  - `fallback_model`
- always appended fallback:
  - `escalate_to_human`

Additional dynamic behavior:

- confidence boost if prior analyzer resolutions mention strategy names
- confidence penalty for repeated failures where retry-centric strategies are underperforming

## Usage Examples

## 1) Standalone RecoveryCopilot

```ts
import { createEventBus } from '@dzupagent/core'
import {
  RecoveryCopilot,
  type FailureContext,
  type RecoveryAction,
  type RecoveryPlan,
} from '@dzupagent/agent'

const eventBus = createEventBus()

const copilot = new RecoveryCopilot({
  eventBus,
  config: {
    maxAttempts: 3,
    requireApprovalForHighRisk: true,
    dryRun: false,
    maxStrategies: 5,
    minAutoExecuteConfidence: 0.6,
  },
  actionHandler: async (action: RecoveryAction, _plan: RecoveryPlan) => {
    switch (action.type) {
      case 'modify_params':
        // mutate generation/runtime params
        return 'params updated'
      case 'fallback_model':
        // switch to backup model
        return 'model switched'
      case 'retry':
        // rerun failed operation
        return 'operation retried'
      case 'human_escalation':
        // open incident/ticket
        return 'escalated'
      default:
        return `handled ${action.type}`
    }
  },
})

const failure: FailureContext = {
  type: 'build_failure',
  error: 'TypeScript error TS2345 in /src/foo.ts line 42',
  runId: 'run-123',
  nodeId: 'compile-node',
  timestamp: new Date(),
  previousAttempts: 0,
}

const result = await copilot.recover(failure)
console.log(result.success, result.summary)
```

## 2) PipelineRuntime Recovery Integration

```ts
import { PipelineRuntime, RecoveryCopilot } from '@dzupagent/agent'
import { createEventBus } from '@dzupagent/core'

const eventBus = createEventBus()

const copilot = new RecoveryCopilot({
  eventBus,
  actionHandler: async () => 'ok',
})

const runtime = new PipelineRuntime({
  definition,
  nodeExecutor,
  recoveryCopilot: {
    copilot,
    enabledForNodes: ['generate', 'test'],
    maxRecoveryAttempts: 3,
  },
  onEvent: (event) => {
    if (event.type === 'pipeline:recovery_attempted') {
      console.log('recovery attempt', event.attempt, event.nodeId)
    }
  },
})
```

## 3) Stuck Detector Trigger -> Plan Creation

```ts
const plan = copilot.handleStuckSignal(
  { stuck: true, reason: 'Tool loop repeating read_file with same args' },
  'run-123',
  'node-read',
)

if (plan && plan.selectedStrategy) {
  await copilot.executePlan(plan)
}
```

## 4) Learning-Backed Recovery (with RecoveryFeedback)

```ts
import { RecoveryFeedback, RecoveryCopilot } from '@dzupagent/agent'

const feedback = new RecoveryFeedback({ store: langGraphStore })

const copilot = new RecoveryCopilot({
  eventBus,
  actionHandler,
  feedback,
})

// recover() will automatically:
// 1) retrieve similar lessons
// 2) adjust strategy confidence
// 3) record new lesson outcome
await copilot.recover(failureContext)
```

## Practical Use Cases

- CI/codegen recovery:
  - build breaks from type errors -> inject build error into prompt + retry.
- flaky external provider:
  - generation timeout -> reduce scope or fallback model instead of hard fail.
- constrained budget/runtime:
  - resource exhaustion -> switch to cheaper model and retry.
- production-safe operation:
  - high-risk rollback path gated by explicit approval before execution.
- pipeline resiliency:
  - node-level failures can recover and retry without aborting whole DAG.

## References and Usage Across Packages

Snapshot as of **April 4, 2026**.

## Direct Runtime References (inside `packages/agent`)

- [`packages/agent/src/pipeline/pipeline-runtime.ts`](../pipeline/pipeline-runtime.ts)
  - only concrete runtime caller of `RecoveryCopilot.recover()`.
- [`packages/agent/src/pipeline/pipeline-runtime-types.ts`](../pipeline/pipeline-runtime-types.ts)
  - config typing for `recoveryCopilot`.
- [`packages/agent/src/self-correction/recovery-feedback.ts`](../self-correction/recovery-feedback.ts)
  - optional memory-backed lesson store used by `RecoveryCopilot`.
- [`packages/agent/src/self-correction/self-learning-hook.ts`](../self-correction/self-learning-hook.ts)
  - consumes `pipeline:recovery_*` events for metrics/callback dispatch.
- [`packages/agent/src/replay/replay-inspector.ts`](../replay/replay-inspector.ts)
  - counts event types containing `recovery` in timelines/summary.

## Cross-Package References (outside `packages/agent`)

- [`packages/server/src/deploy/signal-checkers.ts`](../../../server/src/deploy/signal-checkers.ts)
  - does not instantiate `RecoveryCopilot`; checks whether agent config appears recovery-enabled for deployment confidence.
- [`packages/memory/src/lesson-pipeline.ts`](../../../memory/src/lesson-pipeline.ts)
  - references RecoveryCopilot concept in docs/comments; not directly wired to this module's API at runtime.

## Important Non-Reference

- `packages/agent-adapters/src/recovery/*` is a separate recovery implementation (`AdapterRecoveryCopilot`) and does not import `packages/agent/src/recovery/*`.

## Test Coverage

## Executed Recovery Test Suite (focused run)

Command executed:

- `yarn workspace @dzupagent/agent test -- src/__tests__/failure-analyzer.test.ts src/__tests__/strategy-ranker.test.ts src/__tests__/recovery-executor.test.ts src/__tests__/recovery-copilot.test.ts`

Result:

- 4 test files passed
- 67 tests passed
- 0 failed

## Coverage Metrics for Recovery Files

From `packages/agent/coverage/coverage-summary.json` (focused coverage run):

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `failure-analyzer.ts` | 99.22% | 90.62% | 100% | 99.22% |
| `strategy-ranker.ts` | 100% | 100% | 100% | 100% |
| `recovery-executor.ts` | 100% | 86.36% | 100% | 100% |
| `recovery-copilot.ts` | 77.69% | 64.70% | 94.11% | 77.69% |
| **Recovery folder aggregate** | **88.06%** | **80.48%** | **97.36%** | **88.06%** |

Note:

- global package coverage thresholds fail under focused runs because only recovery tests are executed; this is expected for scoped coverage commands.

## What is covered well

- classification, fingerprinting, recurrence tracking
- ranking math, attempt penalties, custom weight behavior
- executor success/failure/dry-run/approval lifecycle
- copilot plan creation, max-attempt escalation, one-shot recovery, stuck-signal handling, plan lookup/reset

## Gaps and Residual Risk

1. No dedicated tests for `RecoveryFeedback` integration path inside `RecoveryCopilot` (lesson retrieval + lesson write best-effort behavior).
2. No direct tests for `applyLessonBoosts` edge cases (confidence mutation behavior under mixed success/failure history).
3. No direct runtime tests for `PipelineRuntime` invoking `recoveryCopilot.recover()` (config allowlist/budget interactions are implemented but not covered by a dedicated integration test in current suite).
4. Event semantics are overloaded: recovery lifecycle emits `agent:stuck_detected` with different `recovery` suffixes, which can blur telemetry meaning between actual stuck detection and recovery lifecycle events.

## Engineering Notes

## Strengths

- clean separation of concerns with minimal coupling
- explicit typed contracts for failure/strategy/plan/result lifecycle
- operational safety controls (attempt caps, risk-based approval gates, dry-run)
- deterministic and testable strategy ranking mechanics

## Current Tradeoffs

- strategy capping is applied before ranking (`slice` then `rank`), so custom generators should provide reasonable ordering when returning more than `maxStrategies`.
- failure classification heuristics exist both in `FailureAnalyzer` and in `PipelineRuntime.classifyError`, creating two classifiers with potentially divergent behavior.
- `RecoveryCopilot` state (`plans`, attempted strategies, analyzer history) is in-memory; restart behavior depends on external wiring/persistence if continuity is required.

## Recommended Next Additions

1. Add integration tests for `RecoveryCopilot + RecoveryFeedback` with mocked `BaseStore`.
2. Add `PipelineRuntime` integration tests that assert node retry behavior after successful `copilot.recover()`.
3. Add tests that validate approval timeout/cancellation handling at recovery execution boundaries.
4. Consider dedicated recovery event types (instead of reusing `agent:stuck_detected`) for clearer observability and downstream analytics.
