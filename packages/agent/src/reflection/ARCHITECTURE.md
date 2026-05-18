# Reflection Architecture (`packages/agent/src/reflection`)

## Scope
This document describes the reflection subsystem implemented in `packages/agent/src/reflection` and the runtime touchpoints inside `packages/agent/src/agent` that currently invoke it.

In-scope reflection files:
- `run-reflector.ts`
- `reflection-analyzer.ts`
- `reflection-types.ts`
- `in-memory-reflection-store.ts`
- `learning-bridge.ts`
- `index.ts`

In-scope integration files in `packages/agent/src/agent`:
- `run-engine-generate-process.ts` (post-run callback wiring)
- `agent-types-config.ts` (`DzupAgentConfig` reflection fields)

Out of scope:
- `src/self-correction/*` reflection-loop stack (separate subsystem)
- product-level learning services that consume reflection output

## Responsibilities
The subsystem has two independent responsibilities:

1. Post-run behavioral analysis from workflow events.
- `ReflectionAnalyzer` computes aggregate run stats and detects pattern families:
  - `repeated_tool`
  - `error_loop`
  - `slow_step`
  - `successful_strategy`
- It emits a `ReflectionSummary` with a normalized quality score in `[0, 1]`.

2. Standalone run quality scoring from input/output/tool metadata.
- `RunReflector` computes heuristic quality dimensions and an overall score.
- Optional LLM enhancement can override part of the scoring surface when configured.

Bridge responsibility:
- `learning-bridge.ts` provides adapter helpers so callers can map tool-loop stats to `WorkflowEvent[]` and forward summaries into a learning pipeline.

## Structure
`run-reflector.ts`
- Exports:
  - `RunReflector`
  - `ReflectionInput`
  - `ReflectionDimensions`
  - `ReflectionScore`
  - `ReflectorConfig`
- Purpose: score a single run using heuristics, optionally merged with LLM-based scoring.

`reflection-analyzer.ts`
- Exports:
  - `ReflectionAnalyzer`
  - `ReflectionAnalyzerConfig`
- Purpose: analyze ordered `WorkflowEvent[]` and produce `ReflectionSummary`.

`reflection-types.ts`
- Exports:
  - `ReflectionPattern`
  - `ReflectionSummary`
  - `RunReflectionStore`
- Purpose: shared contracts for analyzer output and persistence.

`in-memory-reflection-store.ts`
- Exports:
  - `InMemoryReflectionStore`
- Purpose: volatile `RunReflectionStore` implementation backed by `Map`.

`learning-bridge.ts`
- Exports:
  - `createReflectionLearningBridge`
  - `buildWorkflowEventsFromToolStats`
  - `ReflectionLearningBridgeConfig`
- Purpose: callback composition and event reconstruction from `ToolStat[]`.

`index.ts`
- Reflection-only barrel re-exporting all reflection module symbols.

## Runtime and Control Flow
Primary runtime wiring path today is `processGeneratedRun()` in `src/agent/run-engine-generate-process.ts`.

Control flow:
1. Tool loop finishes and returns `toolStats` plus `stopReason`.
2. If `config.onReflectionComplete` is defined:
- `ReflectionAnalyzer` is created with `config.reflectionAnalyzerConfig`.
- `buildWorkflowEventsFromToolStats(result.toolStats, result.stopReason)` synthesizes workflow events.
- `analyzer.analyze(runId, events)` creates a `ReflectionSummary`.
- `await config.onReflectionComplete(summary)` forwards summary to caller-owned logic.
3. Any error in this block is caught and suppressed; run output is still returned.

Run ID behavior in this path:
- Generated as `params.agentId + ':' + Date.now().toString(36)`.
- This is process-local and time-derived, not globally durable by itself.

`ReflectionAnalyzer` algorithm summary:
- Counts:
  - `errorCount`: number of `step:failed`
  - `toolCallCount`: number of `step:completed`
- Duration:
  - Prefer `workflow:completed.durationMs`
  - Fallback: sum of all `step:completed.durationMs`
- Pattern detection:
  - Repeated started-step runs by `stepId` (threshold default `2`)
  - Consecutive failures (threshold default `2`)
  - Slow completions above `median(durationMs) * slowStepMultiplier` (default `3`)
  - Consecutive successful completions (minimum run `3`)
- Quality score:
  - Base `1.0`
  - Error penalty `-min(errorCount * 0.15, 0.6)`
  - `-0.1` per `error_loop`
  - `-0.05` per `repeated_tool`
  - `-0.3` if `workflow:failed` exists
  - `+0.1` bonus when no errors and at least one completion (capped to `1.0`)
  - Final clamp `[0, 1]`

`RunReflector` flow:
1. Always computes heuristic dimensions:
- `completeness` (weight `0.3`)
- `coherence` (weight `0.2`)
- `toolSuccess` (weight `0.2`)
- `conciseness` (weight `0.1`)
- `reliability` (weight `0.2`)
2. If no `config.llm`, returns heuristic score directly.
3. If `config.llm` exists:
- `llmMode`: `always` or `on-low-score` (default `on-low-score`)
- `llmThreshold`: default `0.6` when in low-score mode
- LLM prompt requests JSON `{ completeness, coherence, relevance, reasoning }`
- Parse/validate/clamp numeric dimensions
- Merge score as `overall = clamp01(0.6 * llmOverall + 0.4 * heuristicOverall)`
- Add `llm_enhanced` flag
4. If LLM call or parse fails, fallback to heuristic score with `llm_reflection_failed` flag.

## Key APIs and Types
Public reflection API surface (`src/reflection/index.ts`, also re-exported from `src/index.ts`):
- `RunReflector`
- `ReflectionAnalyzer`
- `InMemoryReflectionStore`
- `createReflectionLearningBridge(config)`
- `buildWorkflowEventsFromToolStats(toolStats, stopReason)`

Core types:
- `ReflectionInput`: raw scoring input for `RunReflector`
- `ReflectionDimensions`: heuristic/merged dimension scores
- `ReflectionScore`: overall + dimensions + flags
- `ReflectorConfig`: optional LLM scoring options
- `ReflectionAnalyzerConfig`: thresholds for pattern detection
- `ReflectionPattern`: single detected pattern with type/description/indices
- `ReflectionSummary`: aggregate result for one run
- `RunReflectionStore`: persistence contract (`save`, `get`, `list`, `getPatterns`)
- `ReflectionLearningBridgeConfig`: bridge callback/store/filter options

`DzupAgentConfig` integration (`src/agent/agent-types-config.ts`):
- `onReflectionComplete?: (summary: ReflectionSummary) => Promise<void>`
- `reflectionAnalyzerConfig?: ReflectionAnalyzerConfig`

## Dependencies
Internal dependencies used by reflection module:
- `reflection-analyzer.ts` imports `WorkflowEvent` from `src/workflow/workflow-types.ts`.
- `learning-bridge.ts` imports:
  - `WorkflowEvent` from `src/workflow/workflow-types.ts`
  - `ToolStat` and `StopReason` from `src/agent/tool-loop.ts`
  - reflection summary/store contracts from `reflection-types.ts`

Runtime integration dependency:
- `src/agent/run-engine-generate-process.ts` imports `ReflectionAnalyzer` and `buildWorkflowEventsFromToolStats`.

External library usage:
- Files in `src/reflection/*` do not directly import third-party packages.
- They are packaged as part of `@dzupagent/agent` and consume local domain types.

## Integration Points
Package exports:
- Root export: `src/index.ts` re-exports all reflection classes/types/functions.
- Compat export: `src/compat.ts` includes `export * from './reflection/index.js'`.

Agent runtime:
- Reflection callback executes in `processGeneratedRun()` after output filtering and summary updates.
- Reflection processing is best-effort; failures are intentionally non-fatal.

Learning pipeline handoff:
- `createReflectionLearningBridge()` composes:
  - optional `filter(summary)` gate
  - optional `store.save(summary)`
  - mandatory `onSummary(summary)` callback
- Bridge errors propagate from `store.save` or `onSummary`; the run engine catches them when this bridge is used as `onReflectionComplete`.

Tool-loop adaptation:
- `buildWorkflowEventsFromToolStats()` maps aggregate tool stats into analyzer-compatible events and appends terminal workflow status based on `StopReason`.

## Testing and Observability
Reflection-specific tests in `src/reflection`:
- `reflection.test.ts`
  - analyzer counters, pattern detection, quality scoring, threshold behavior
  - in-memory store CRUD ordering and pattern queries
- `learning-bridge.test.ts`
  - tool-stat-to-event conversion
  - stop-reason terminal mapping
  - filter/store/callback composition
  - end-to-end analyzer + bridge + store flow

Cross-folder reflection tests in `src/__tests__`:
- `run-reflector.test.ts`
  - heuristic dimension behavior, flags, weighted overall, edge cases
- `run-reflector-llm.test.ts`
  - LLM gating modes, prompt composition, merge math, parse failures, clamping

Observability characteristics:
- Reflection itself does not emit dedicated event-bus telemetry.
- Runtime path intentionally swallows reflection callback failures with no built-in logging.
- Persistence and downstream metrics are caller-owned via `onReflectionComplete` and custom `RunReflectionStore` implementations.

## Risks and TODOs
- Synthetic event reconstruction can distort chronology.
  - `buildWorkflowEventsFromToolStats()` derives events from aggregates, not original ordered traces.
  - It emits all success phases first, then all failures, which can amplify/alter `error_loop` and `successful_strategy` detection.

- Stop-reason compression to terminal workflow status is coarse.
  - Only `stuck` and `error` become `workflow:failed`.
  - Other terminal reasons (for example `approval_pending`, `token_exhausted`, `budget_exceeded`) are currently represented as `workflow:completed` in reconstructed events.

- Reflection callback failures are silent at runtime.
  - The catch block in `processGeneratedRun()` protects run success but hides reflection regressions unless hosts add their own instrumentation.

- `RunReflector` is not wired into `DzupAgent.generate()` default flow.
  - Runtime post-run hook currently uses `ReflectionAnalyzer` only.
  - `RunReflector` remains an explicit API callers must invoke themselves.

- Default store is non-durable and unbounded.
  - `InMemoryReflectionStore` is process-local and has no retention cap.
  - Production deployments need a durable `RunReflectionStore` implementation with retention and indexing policy.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewritten against current `src/reflection/*` implementation and `run-engine-generate-process.ts` integration.