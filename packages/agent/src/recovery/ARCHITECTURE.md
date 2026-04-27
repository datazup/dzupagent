# Recovery Module Architecture (`packages/agent/src/recovery`)

## Scope
This document describes the recovery subsystem implemented in `packages/agent/src/recovery` inside `@dzupagent/agent`.

Included source files:
- `recovery-types.ts`
- `failure-analyzer.ts`
- `strategy-ranker.ts`
- `recovery-executor.ts`
- `recovery-copilot.ts`
- `index.ts`

The scope is limited to the package-local recovery layer that:
- classifies and fingerprints failures,
- proposes and ranks recovery strategies,
- executes approved recovery actions,
- optionally learns from persisted recovery lessons.

The document also covers direct integration points in `packages/agent/src/pipeline` and `packages/agent/src/self-correction` where this recovery layer is consumed.

## Responsibilities
The recovery subsystem is responsible for these concrete behaviors:

- Define a typed recovery domain model.
- `FailureType`, `FailureContext`, `RecoveryAction`, `RecoveryStrategy`, `RecoveryPlan`, `RecoveryResult`, and `RecoveryCopilotConfig` are declared in `recovery-types.ts`.

- Analyze runtime failures.
- `FailureAnalyzer` classifies error text with regex patterns, builds normalized fingerprints, tracks in-memory failure history, and extracts hints (`file`, `line`, `httpStatus`, `module`).

- Rank strategy candidates.
- `StrategyRanker` computes a weighted score from confidence, risk, and estimated steps, and penalizes already-attempted strategy names.

- Execute selected strategies.
- `RecoveryExecutor` enforces selected-strategy presence, optional approval gate checks for high-risk plans, optional dry-run mode, sequential action execution via injected `ActionHandler`, and lifecycle event emission.

- Orchestrate end-to-end recovery.
- `RecoveryCopilot` coordinates analysis, strategy generation, ranking, selection, execution, and plan bookkeeping.

- Optional learning loop.
- When `RecoveryFeedback` is injected, `RecoveryCopilot.recover(...)` retrieves similar lessons before planning and records outcome lessons after execution (best effort).

## Structure
Module layout and role split:

- `recovery-types.ts`
- Pure type contracts for failure taxonomy, plan lifecycle, actions, strategy metadata, result payloads, and copilot config.

- `failure-analyzer.ts`
- `FailureAnalyzer` class with in-memory history and fingerprint index.
- Exports `FailureHistoryEntry` and `FailureAnalysis`.

- `strategy-ranker.ts`
- `StrategyRanker` class plus `RankingWeights`.
- Internal risk mapping: `low -> 1.0`, `medium -> 0.5`, `high -> 0.1`.

- `recovery-executor.ts`
- `RecoveryExecutor` class.
- Runtime dependencies injected via `RecoveryExecutorConfig`:
  - `eventBus: DzupEventBus`
  - optional `approvalGate: ApprovalGate`
  - `copilotConfig: RecoveryCopilotConfig`
  - `actionHandler: ActionHandler`

- `recovery-copilot.ts`
- `RecoveryCopilot` class and `StrategyGenerator` type.
- Contains:
  - default config,
  - default strategy generator,
  - lesson-based confidence adjustment (`applyLessonBoosts`),
  - internal in-memory plan map.

- `index.ts`
- Re-exports all public recovery symbols.

Public package export surface:
- `packages/agent/src/index.ts` re-exports the same recovery APIs from the package root entrypoint.

## Runtime and Control Flow
Primary runtime paths:

1. Plan creation (`RecoveryCopilot.createPlan`)
- Guard: if `failureContext.previousAttempts >= config.maxAttempts`, return a failed escalation plan (`human_escalation` action, `selectedStrategy: null`).
- Analyze with `FailureAnalyzer.analyze(...)`.
- Generate candidate strategies via injected `strategyGenerator` or built-in `defaultStrategyGenerator`.
- If lessons are provided, mutate strategy confidence through `applyLessonBoosts(...)`.
- Cap strategy list to `maxStrategies`.
- Rank with `StrategyRanker.rank(...)`.
- Select with `StrategyRanker.selectBest(..., minAutoExecuteConfidence)`.
- Store plan in internal `Map` and emit event-bus telemetry (`type: 'agent:stuck_detected'`).

2. Plan execution (`RecoveryCopilot.executePlan` -> `RecoveryExecutor.execute`)
- Set `plan.status = 'approved'` before executor handoff.
- Executor checks `selectedStrategy`.
- For high-risk strategy + `requireApprovalForHighRisk` + available `approvalGate`, wait on `ApprovalGate.waitForApproval(...)`.
- In dry-run mode, mark completed without calling `actionHandler`.
- Otherwise execute strategy actions in order via `actionHandler(action, plan)`.
- On first action error, mark plan failed and stop.
- On full success, mark completed and set `completedAt`.
- Emit lifecycle and per-action events through the bus.
- After execution, copilot records failure history in analyzer and marks selected strategy as attempted in ranker.

3. One-shot recovery (`RecoveryCopilot.recover`)
- Re-analyze failure.
- If feedback module exists, load past lessons with `feedback.retrieveSimilar(analysis.type, nodeId)`.
- Create plan with optional lesson context.
- If escalation plan is returned (`status: 'failed'`), return early.
- Execute plan.
- Record lesson via `feedback.recordOutcome(...)` in a try/catch (best effort only).

4. Stuck-signal bridge (`RecoveryCopilot.handleStuckSignal`)
- Accepts `StuckStatus` from guardrail layer.
- If `stuck === false`, returns `null`.
- If `stuck === true`, creates a `FailureContext` with `type: 'generation_failure'`, derives `previousAttempts` from in-memory plans for that run, and returns a created plan.

5. Pipeline runtime integration (`PipelineRuntime.attemptRecovery`)
- `PipelineRuntime` checks `config.recoveryCopilot` enablement and node allowlist.
- Enforces run-scoped recovery attempt budget (`maxRecoveryAttempts`, default `3`).
- Emits `pipeline:recovery_attempted`.
- Builds `FailureContext` with `classifyFailureType(errorMessage, nodeType)` from `pipeline-runtime/error-classification.ts`.
- Calls `rc.copilot.recover(failureContext)`.
- Emits `pipeline:recovery_succeeded` or `pipeline:recovery_failed`.
- Returns boolean to control whether failed node should be retried.

Default strategy generation behavior in `recovery-copilot.ts`:
- `build_failure`: `retry_with_fix_prompt`, `reduce_scope`
- `test_failure`: `retry_with_test_context`, `skip_failing_tests`
- `timeout`: `retry_with_smaller_scope`, `simple_retry`
- `resource_exhaustion`: `fallback_to_cheaper_model`, `reduce_scope_and_retry`
- `generation_failure`: `simple_retry`, `fallback_model`
- always appends `escalate_to_human`

## Key APIs and Types
Primary classes:
- `RecoveryCopilot`
  - `createPlan(failureContext, pastLessons?)`
  - `executePlan(plan)`
  - `recover(failureContext)`
  - `handleStuckSignal(stuckStatus, runId, nodeId?)`
  - `getPlan(planId)`, `getPlansForRun(runId)`, `getAnalyzer()`, `getRanker()`, `reset()`

- `RecoveryExecutor`
  - `execute(plan)`

- `FailureAnalyzer`
  - `classifyError(error)`
  - `fingerprint(error)`
  - `analyze(ctx)`
  - `recordFailure(ctx, resolution?)`
  - `getHistory()`, `reset()`

- `StrategyRanker`
  - `rank(strategies)`
  - `computeScore(strategy)`
  - `selectBest(strategies, minConfidence?)`
  - `markAttempted(name)`, `wasAttempted(name)`, `reset()`

Important extension points:
- `ActionHandler`
- async callback responsible for executing concrete recovery actions.

- `StrategyGenerator`
- pluggable function for custom strategy generation.

- `RecoveryFeedback` integration (optional dependency)
- used for retrieving similar lessons and recording outcomes, but implemented in `src/self-correction/recovery-feedback.ts`.

Core types from `recovery-types.ts`:
- Failure model: `FailureType`, `FailureContext`
- Strategy model: `RecoveryActionType`, `RecoveryAction`, `RiskLevel`, `RecoveryStrategy`
- Plan/result model: `RecoveryPlanStatus`, `RecoveryPlan`, `RecoveryResult`
- Config model: `RecoveryCopilotConfig`

## Dependencies
Direct code dependencies inside this package:

- `@dzupagent/core`
- Provides `DzupEventBus` type used by `RecoveryExecutor` and `RecoveryCopilot` wiring.

- `../approval/approval-gate.js`
- Optional human approval for high-risk strategies.

- `../guardrails/stuck-detector.js`
- `StuckStatus` input type used by `handleStuckSignal`.

- `../self-correction/recovery-feedback.js`
- Optional persistence-backed lesson loop for strategy confidence adaptation.

Package-level dependency context (`packages/agent/package.json`):
- Runtime deps include `@dzupagent/core`, `@dzupagent/agent-types`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`.
- Peer deps include `@langchain/core`, `@langchain/langgraph`, and `zod`.

## Integration Points
Confirmed call and contract boundaries in `packages/agent`:

- Pipeline runtime caller
- `src/pipeline/pipeline-runtime.ts` (`attemptRecovery`) is the concrete runtime callsite of `RecoveryCopilot.recover(...)`.

- Pipeline runtime config contract
- `src/pipeline/pipeline-runtime-types.ts` defines `recoveryCopilot` runtime options:
  - `copilot`
  - optional `enabledForNodes`
  - optional `maxRecoveryAttempts`

- Pipeline event factory
- `src/pipeline/pipeline-runtime/runtime-events.ts` provides typed recovery events:
  - `pipeline:recovery_attempted`
  - `pipeline:recovery_succeeded`
  - `pipeline:recovery_failed`

- Package root exports
- `src/index.ts` exports recovery classes/types and separately exports `RecoveryFeedback` from self-correction.

- Self-correction bridge
- `RecoveryCopilot` uses `RecoveryFeedback` when injected, but recovery module remains operational without it.

## Testing and Observability
Recovery-focused tests under `packages/agent/src/__tests__`:

- `failure-analyzer.test.ts`
- verifies classification, fingerprint stability, recurring detection, extracted info fields, history tracking, and reset behavior.

- `strategy-ranker.test.ts`
- verifies ranking order, risk/cost effects, attempted-strategy penalties, threshold behavior, and custom weight overrides.

- `recovery-executor.test.ts`
- verifies successful sequential execution, first-failure stop behavior, dry-run behavior, high-risk approval gating via `ApprovalGate`, and event emission.

- `recovery-copilot.test.ts`
- verifies plan creation, max-attempt escalation, custom strategy generator support, one-shot `recover(...)`, stuck-signal bridging, plan lookups, reset, and event emission.

Related but separate coverage:
- `pipeline/__tests__/error-classification.test.ts` validates the failure classifier used by `PipelineRuntime` before calling recovery.
- `recovery-feedback-deep.test.ts` and portions of `self-correction-deep.test.ts` validate `RecoveryFeedback`, but these do not directly assert `RecoveryCopilot + RecoveryFeedback` end-to-end wiring.

Observability channels:
- Recovery module emits event-bus entries in executor/copilot using `type: 'agent:stuck_detected'` plus `reason`/`recovery` fields.
- Pipeline runtime emits explicit `pipeline:recovery_*` events around recovery attempts/outcomes.

## Risks and TODOs
Current implementation risks and follow-up items grounded in source behavior:

- In-memory-only state in copilot internals.
- `plans`, analyzer history, and attempted strategy tracking are process-local and reset on restart.

- Event semantic overload.
- Recovery lifecycle uses `agent:stuck_detected` (same event type used elsewhere for actual stuck detection), which can blur telemetry interpretation.

- Dual failure classifiers.
- Recovery module classifier (`FailureAnalyzer.classifyError`) and pipeline runtime classifier (`classifyFailureType`) are separate implementations and can diverge over time.

- Strategy cap order.
- `createPlan` applies `maxStrategies` by slicing before ranking. If a custom generator returns many strategies, earlier array order influences what survives.

- Best-effort lesson persistence.
- Failures in `feedback.recordOutcome(...)` are swallowed by design, so persistence outages do not fail recovery but do reduce learning continuity.

- Integration test gap for copilot-feedback loop.
- There are tests for copilot and for feedback independently, but no dedicated test that asserts `RecoveryCopilot.recover(...)` with injected `RecoveryFeedback` across retrieval + boost + record.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

