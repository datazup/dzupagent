# Recovery Module Architecture (`packages/agent/src/recovery`)

## Scope
This document describes the recovery subsystem in `packages/agent/src/recovery` within `@dzupagent/agent`.

In-scope source files:
- `default-strategy-generator.ts`
- `escalation-plan.ts`
- `failure-analyzer.ts`
- `feedback-recorder.ts`
- `index.ts`
- `lesson-boosts.ts`
- `recovery-copilot.ts`
- `recovery-executor.ts`
- `recovery-types.ts`
- `strategy-ranker.ts`

Scope boundaries:
- Focuses on recovery planning and execution primitives owned by this module.
- Covers direct runtime integration where recovery is invoked by pipeline runtime (`src/pipeline/pipeline-runtime/node-side-effects.ts`).
- Does not describe unrelated stuck-detection internals outside recovery, except where recovery consumes `StuckStatus` types or emits shared event types.

## Responsibilities
The recovery module is responsible for:

- Modeling recovery domain types.
- `recovery-types.ts` defines `FailureType`, `FailureContext`, `RecoveryAction`, `RecoveryStrategy`, `RecoveryPlan`, `RecoveryCopilotConfig`, and `RecoveryResult`.

- Classifying and fingerprinting failures.
- `FailureAnalyzer` classifies error text with regex patterns, normalizes/fingerprints error strings, tracks in-memory occurrence history, and extracts lightweight structured hints (`file`, `line`, `httpStatus`, `module`).

- Generating candidate strategies.
- `defaultStrategyGenerator` maps analyzed failure categories to strategy sets and always appends a human escalation fallback.
- It also adjusts confidence based on recurring fingerprints and previous resolution text.

- Ranking and selecting strategies.
- `StrategyRanker` scores strategies using weighted confidence/risk/cost and penalizes previously attempted strategy names.

- Executing approved plans.
- `RecoveryExecutor` enforces approval for high-risk strategies when configured, supports dry-run mode, executes strategy actions sequentially through injected `ActionHandler`, and updates plan status/error fields.

- Orchestrating end-to-end recovery.
- `RecoveryCopilot` composes analyzer + generator + lesson boosts + ranker + executor, stores plan history in memory, and exposes one-shot `recover(...)` plus explicit `createPlan(...)` / `executePlan(...)` APIs.

- Recording lessons (optional, best effort).
- When `RecoveryFeedback` is provided, `RecoveryCopilot` retrieves similar lessons before planning and records outcomes via `recordRecoveryFeedback(...)` after execution or escalation.

## Structure
Module composition and roles:

- `recovery-types.ts`
- Pure type contracts for failure taxonomy, actions, strategies, plans, config, and results.

- `failure-analyzer.ts`
- `FailureAnalyzer` + `FailureAnalysis` + `FailureHistoryEntry`.
- Maintains:
  - `history: FailureHistoryEntry[]`
  - `fingerprints: Map<string, { count: number; resolutions: string[] }>`

- `default-strategy-generator.ts`
- Exports `StrategyGenerator` function type and `defaultStrategyGenerator(...)` implementation.
- Built-in strategy catalog per `FailureType`.

- `lesson-boosts.ts`
- `applyLessonBoosts(...)` mutates strategy confidence using success/failure tallies from `RecoveryLesson[]`.

- `strategy-ranker.ts`
- `StrategyRanker` + `RankingWeights`.
- Maintains attempted strategy set to avoid repeating failed options.

- `escalation-plan.ts`
- `buildEscalationPlan(...)` factory for terminal max-attempts escalation plans.

- `recovery-executor.ts`
- `RecoveryExecutor` + `ActionHandler` + `RecoveryExecutorConfig`.
- Handles approval, dry-run, sequential execution, and event emission.

- `feedback-recorder.ts`
- `recordRecoveryFeedback(...)` helper that creates a `RecoveryLesson`, stores it via `RecoveryFeedback.recordOutcome(...)`, and appends candidate audit entry metadata.

- `recovery-copilot.ts`
- `RecoveryCopilot` orchestration class.
- Owns module defaults:
  - `maxAttempts: 3`
  - `requireApprovalForHighRisk: true`
  - `dryRun: false`
  - `maxStrategies: 5`
  - `minAutoExecuteConfidence: 0.6`

- `index.ts`
- Recovery module barrel export.

Public export surface shape:
- Recovery symbols are exported from package root `src/index.ts`.
- `package.json` does not define a dedicated `./recovery` subpath export; consumers import recovery APIs from `@dzupagent/agent` root exports.

## Runtime and Control Flow
Primary runtime flows:

1. Failure arrives as `FailureContext`.
- Pipeline runtime path (`attemptRecovery`) constructs `FailureContext` using:
  - `classifyFailureType(errorMessage, nodeType)`
  - `previousAttempts = attemptsUsed - 1`
  - run and node identifiers.

2. Plan creation (`RecoveryCopilot.createPlan`).
- If `failureContext.previousAttempts >= maxAttempts`, copilot returns `buildEscalationPlan(...)` with status `failed` and `selectedStrategy: null`.
- Otherwise:
  - analyze failure (`FailureAnalyzer.analyze`)
  - generate strategies (`strategyGenerator` or `defaultStrategyGenerator`)
  - optionally apply lesson confidence adjustments (`applyLessonBoosts`) when past lessons exist
  - cap strategy list to `maxStrategies`
  - rank and select (`StrategyRanker.rank`, `StrategyRanker.selectBest`)
  - persist plan in in-memory map and emit telemetry event.

3. Plan execution (`RecoveryCopilot.executePlan` -> `RecoveryExecutor.execute`).
- Copilot marks status `approved` before dispatch.
- Executor behavior:
  - fail immediately if no selected strategy
  - if selected strategy is `high` risk and approval is required and gate exists, wait on `ApprovalGate.waitForApproval(...)`
  - in dry-run mode, mark `completed` without invoking action handler
  - otherwise run actions in order using injected `actionHandler(action, plan)`
  - on first action error, mark plan failed and stop
  - on success, mark completed and set `completedAt`.
- After executor returns, copilot:
  - records failure/resolution signal in analyzer history
  - marks selected strategy as attempted in ranker.

4. One-shot recovery (`RecoveryCopilot.recover`).
- Re-analyzes failure for lesson lookup keying.
- If `feedback` exists, calls `feedback.retrieveSimilar(analysis.type, nodeId)`.
- Creates plan using retrieved lessons.
- If plan already failed (escalation), returns immediate failed result and still attempts to persist feedback.
- Otherwise executes plan and persists success/failure feedback best-effort.

5. Pipeline retry decision (`attemptRecovery`).
- Emits `pipeline:recovery_attempted` before calling copilot.
- Calls `copilot.recover(failureContext)`.
- Emits:
  - `pipeline:recovery_succeeded` and returns `true` when successful.
  - `pipeline:recovery_failed` and returns `false` when unsuccessful or when recovery throws.

6. Stuck-signal helper path.
- `RecoveryCopilot.handleStuckSignal(stuckStatus, runId, nodeId?)` converts positive `StuckStatus` into a synthetic `generation_failure` context and calls `createPlan`.
- In current codebase, this method is validated by tests and exposed publicly, but there is no direct production call site in `packages/agent/src`.

## Key APIs and Types
Primary classes:

- `RecoveryCopilot`
- Constructor options:
  - `eventBus`
  - `actionHandler`
  - optional `config`
  - optional `approvalGate`
  - optional `strategyGenerator`
  - optional `feedback`
- Public methods:
  - `createPlan(failureContext, pastLessons?)`
  - `executePlan(plan)`
  - `recover(failureContext)`
  - `handleStuckSignal(stuckStatus, runId, nodeId?)`
  - `getPlan(planId)`
  - `getPlansForRun(runId)`
  - `getAnalyzer()`
  - `getRanker()`
  - `reset()`

- `RecoveryExecutor`
- Public method: `execute(plan)`.

- `FailureAnalyzer`
- Public methods:
  - `classifyError(error)`
  - `fingerprint(error)`
  - `analyze(ctx)`
  - `recordFailure(ctx, resolution?)`
  - `getHistory()`
  - `reset()`

- `StrategyRanker`
- Public methods:
  - `rank(strategies)`
  - `computeScore(strategy)`
  - `selectBest(strategies, minConfidence?)`
  - `markAttempted(strategyName)`
  - `wasAttempted(strategyName)`
  - `reset()`

Extension points:

- `StrategyGenerator`
- Custom strategy generation hook used by `RecoveryCopilot`.

- `ActionHandler`
- Runtime action execution hook used by `RecoveryExecutor`.

- `RecoveryFeedback` integration
- Optional persistence/learning hook used during `recover(...)`.

Key domain types:

- Failure: `FailureType`, `FailureContext`
- Action/strategy: `RecoveryActionType`, `RecoveryAction`, `RiskLevel`, `RecoveryStrategy`
- Plan/result: `RecoveryPlanStatus`, `RecoveryPlan`, `RecoveryResult`
- Config: `RecoveryCopilotConfig`, `RankingWeights`, `RecoveryExecutorConfig`

## Dependencies
Direct dependencies used by recovery code:

- `@dzupagent/core/events`
- Provides `DzupEventBus` type used for telemetry emission and approval flow wiring.

- `../approval/approval-gate.js`
- Optional `ApprovalGate` integration for high-risk strategy gating.

- `../guardrails/stuck-detector.js`
- Supplies `StuckStatus` type consumed by `handleStuckSignal`.

- `../self-correction/recovery-feedback.js`
- Optional lesson retrieval and recording (`RecoveryFeedback`, `RecoveryLesson`).

- `../utils/exact-optional.js`
- `omitUndefined(...)` utility used when constructing config/context objects.

Package-level context (`packages/agent/package.json`):

- Runtime deps include `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/runtime-contracts`, and other internal packages.
- Peer deps include `@langchain/core`, `@langchain/langgraph`, and `zod`.

## Integration Points
Confirmed integration boundaries in `packages/agent`:

- Pipeline runtime invocation.
- `src/pipeline/pipeline-runtime/node-side-effects.ts` owns the production recovery entrypoint (`attemptRecovery`).

- Pipeline runtime config.
- `src/pipeline/pipeline-runtime-types.ts` exposes optional `recoveryCopilot` runtime config:
  - `copilot`
  - optional `enabledForNodes`
  - optional `maxRecoveryAttempts`.

- Pipeline event stream.
- `src/pipeline/pipeline-runtime/runtime-events.ts` defines:
  - `pipeline:recovery_attempted`
  - `pipeline:recovery_succeeded`
  - `pipeline:recovery_failed`.

- Self-learning metrics/hook.
- `src/self-correction/self-learning-hook.ts` increments recovery metrics from pipeline recovery events and triggers optional callbacks.
- `src/self-correction/self-learning-runtime.ts` forwards `recoveryCopilot` config into enhanced pipeline runtime.

- Package exports.
- Recovery classes/types are exported via `src/recovery/index.ts` and re-exported by package root `src/index.ts`.

## Testing and Observability
Recovery module tests in `src/__tests__`:

- `failure-analyzer.test.ts`
- Covers classification routes, fingerprint normalization behavior, recurrence detection, structured info extraction, history accumulation, and reset.

- `strategy-ranker.test.ts`
- Covers confidence/risk/cost ranking, attempted-strategy penalty behavior, threshold fallback behavior, and custom weight overrides.

- `recovery-executor.test.ts`
- Covers single/multi-step execution, no-strategy failure handling, first-error short-circuit, dry-run behavior, approval granted/rejected flows, and event emission.

- `recovery-copilot.test.ts`
- Covers plan creation, max-attempt escalation, custom strategy generation, one-shot recovery, stuck signal handling, plan retrieval/reset, event emission, and `RecoveryFeedback` round-trip recording for success/failure/escalation cases.

Related integration tests:

- `pipeline/__tests__/error-classification.test.ts`
- Covers keyword-based failure classification used by pipeline runtime before invoking recovery.

Observability behavior:

- Recovery copilot/executor emit event-bus messages with `type: 'agent:stuck_detected'` and encode recovery lifecycle in `reason`/`recovery` fields.
- Pipeline runtime emits explicit `pipeline:recovery_*` events for operator-facing runtime timelines.

## Risks and TODOs
Current risks and maintenance gaps based on implementation:

- In-memory state only.
- Copilot plan storage, analyzer history, and ranker attempt tracking are process-local; restart loses recovery context.

- Event type overload.
- Recovery lifecycle reuses `agent:stuck_detected`, which can blur telemetry semantics between true stuck detection and recovery progress logging.

- Two separate failure classifiers.
- `FailureAnalyzer.classifyError(...)` and pipeline `classifyFailureType(...)` evolve independently and can drift in matching behavior or precedence.

- Strategy capping before ranking.
- `createPlan(...)` slices to `maxStrategies` before ranking; large custom generator outputs are sensitive to generator output order.

- Strategy/lesson naming coupling.
- Lesson boosts depend on exact strategy-name matches; strategy renames can silently reduce learning effectiveness.

- Best-effort feedback persistence.
- `recordRecoveryFeedback(...)` swallows persistence errors by design; outages reduce learning continuity without surfacing hard failures.

- Escalation fallback naming inconsistency.
- Default generator uses strategy name `escalate_to_human`, while max-attempt escalation plan uses `human_escalation`; this can fragment strategy-level analytics unless normalized downstream.

- Unwired stuck helper in production path.
- `handleStuckSignal(...)` currently has no non-test call site in `packages/agent/src`; integration remains optional and caller-driven.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js