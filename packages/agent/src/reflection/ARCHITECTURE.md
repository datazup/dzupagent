# Reflection Architecture (`packages/agent/src/reflection`)

## Scope
This document covers the reflection subsystem inside `@dzupagent/agent` at `packages/agent/src/reflection`:

- `run-reflector.ts` (heuristic and optional LLM scoring of a single run result)
- `reflection-analyzer.ts` (pattern detection and aggregate quality scoring from `WorkflowEvent[]`)
- `reflection-types.ts` (summary, pattern, and store interfaces)
- `in-memory-reflection-store.ts` (non-persistent `RunReflectionStore` implementation)
- `learning-bridge.ts` (wiring helpers from reflection summaries into learning handlers)
- `index.ts` (submodule barrel)

It also covers the current in-package runtime integration point in `src/agent/run-engine.ts` and public exports from `src/index.ts`.

## Responsibilities
The reflection subsystem currently has two distinct responsibilities:

1. Post-run pattern analysis for agent tool-loop outcomes.
- `ReflectionAnalyzer` consumes normalized `WorkflowEvent[]`, detects recurring execution patterns, and emits `ReflectionSummary`.
- `run-engine.ts` invokes this path when `DzupAgentConfig.onReflectionComplete` is configured.

2. Standalone run quality scoring API.
- `RunReflector` scores input/output/tool-result quality with lightweight heuristics.
- It can optionally enrich scores with an external LLM callback (`ReflectorConfig.llm`) using `always` or `on-low-score` modes.
- This path is exported but not used by `run-engine.ts` in the current package runtime.

## Structure
Files and roles:

- `run-reflector.ts`
- Types: `ReflectionInput`, `ReflectionDimensions`, `ReflectionScore`, `ReflectorConfig`
- Class: `RunReflector`
- Main methods: `score()` (async heuristic + optional LLM), `scoreHeuristic()` (sync heuristic-only)

- `reflection-analyzer.ts`
- Types: `ReflectionAnalyzerConfig`
- Class: `ReflectionAnalyzer`
- Main method: `analyze(runId, events)`
- Internal detectors: repeated tool runs, consecutive error loops, slow steps, successful strategies

- `reflection-types.ts`
- Domain contracts: `ReflectionPattern`, `ReflectionSummary`, `RunReflectionStore`

- `in-memory-reflection-store.ts`
- Class: `InMemoryReflectionStore implements RunReflectionStore`
- Extra test-oriented helpers: `size` getter and `clear()`

- `learning-bridge.ts`
- Type: `ReflectionLearningBridgeConfig`
- Functions:
  - `createReflectionLearningBridge(config)`
  - `buildWorkflowEventsFromToolStats(toolStats, stopReason)`

- `index.ts`
- Reflection-only barrel re-exporting all of the above.

- `src/index.ts`
- Package-level public export surface for reflection APIs.

## Runtime and Control Flow
### 1) Runtime path wired into `DzupAgent.generate()`
Current integration is in `src/agent/run-engine.ts` after the tool loop completes:

1. `result.toolStats` and `result.stopReason` are available from the tool loop.
2. If `config.onReflectionComplete` is set:
- `buildWorkflowEventsFromToolStats(result.toolStats, result.stopReason)` creates synthetic `WorkflowEvent[]`.
- `new ReflectionAnalyzer(config.reflectionAnalyzerConfig).analyze(runId, events)` produces `ReflectionSummary`.
- `await config.onReflectionComplete(summary)` is invoked.
3. Any error in analyzer/bridge callback is swallowed (`try/catch` with no rethrow), so reflection is best-effort and never changes run success/failure semantics.

Run ID generation for this callback path is currently ephemeral: `agentId + ':' + Date.now().toString(36)`.

### 2) `ReflectionAnalyzer` scoring flow
For each `analyze(runId, events)` call:

1. Basic stats:
- `errorCount` from `step:failed`
- `toolCallCount` from `step:completed`
- `durationMs` from `workflow:completed.durationMs` when present; otherwise sum of completed step durations

2. Pattern detection:
- `repeated_tool`: repeated consecutive `step:started` with same `stepId`
- `error_loop`: consecutive `step:failed`
- `slow_step`: `step:completed.durationMs > median(completedDurations) * slowStepMultiplier` (default multiplier `3`)
- `successful_strategy`: runs of at least 3 completions without intervening failure

3. Quality score computation (clamped `[0,1]`):
- start `1.0`
- `- min(errorCount * 0.15, 0.6)`
- `- 0.1` per `error_loop` pattern
- `- 0.05` per `repeated_tool` pattern
- `- 0.3` if any `workflow:failed`
- `+ 0.1` success bonus when `errorCount === 0` and at least one completion (capped to `1.0`)

### 3) `RunReflector` flow (exported scoring API)
`RunReflector.score(input)`:

1. Compute deterministic heuristic result (`scoreHeuristic`) with dimensions:
- `completeness` (0.3)
- `coherence` (0.2)
- `toolSuccess` (0.2)
- `conciseness` (0.1)
- `reliability` (0.2)

2. If no `config.llm`, return heuristic score.

3. If `config.llm` exists:
- mode `always` or `on-low-score` (default) with threshold default `0.6`
- when invoked, send a fixed JSON-output prompt and parse response
- require numeric `completeness`, `coherence`, `relevance`; clamp to `[0,1]`
- merge with heuristic dimensions and blend overall score as `0.6 * llmOverall + 0.4 * heuristicOverall`

4. On LLM failure/parse failure: return heuristic result plus `llm_reflection_failed` flag.

## Key APIs and Types
### Public classes/functions
- `RunReflector`
- `ReflectionAnalyzer`
- `InMemoryReflectionStore`
- `createReflectionLearningBridge(config)`
- `buildWorkflowEventsFromToolStats(toolStats, stopReason)`

### Core type contracts
- `ReflectionInput`
- `ReflectionScore`
- `ReflectionDimensions`
- `ReflectorConfig`
- `ReflectionAnalyzerConfig`
- `ReflectionPattern`
- `ReflectionSummary`
- `RunReflectionStore`
- `ReflectionLearningBridgeConfig`

### `DzupAgentConfig` integration fields
Declared in `src/agent/agent-types.ts`:

- `onReflectionComplete?: (summary: ReflectionSummary) => Promise<void>`
- `reflectionAnalyzerConfig?: ReflectionAnalyzerConfig`

## Dependencies
### Internal module dependencies (within `packages/agent`)
- `reflection-analyzer.ts` depends on `workflow/workflow-types.ts` (`WorkflowEvent`).
- `learning-bridge.ts` depends on:
- `agent/tool-loop.ts` (`ToolStat`, `StopReason`)
- `workflow/workflow-types.ts` (`WorkflowEvent`)
- `reflection-types.ts`
- Runtime hook lives in `agent/run-engine.ts`.

### Package-level dependencies
The reflection files themselves do not import external npm libraries directly. They run on local TypeScript/domain types and are exported by `@dzupagent/agent`.

## Integration Points
- Runtime hook:
- `src/agent/run-engine.ts` invokes analyzer + callback after each run when `onReflectionComplete` exists.

- Config surface:
- `src/agent/agent-types.ts` exposes `onReflectionComplete` and `reflectionAnalyzerConfig`.

- Public exports:
- `src/reflection/index.ts` exports reflection internals.
- `src/index.ts` re-exports reflection APIs as part of package public surface.

- Learning bridge contract:
- `createReflectionLearningBridge` provides callback composition (`filter` -> optional `store.save` -> `onSummary`).

- Tool-loop adaptation contract:
- `buildWorkflowEventsFromToolStats` transforms aggregate tool stats into analyzer-compatible events, including terminal workflow success/failure based on stop reason.

## Testing and Observability
### Test coverage in scope
Reflection behavior is covered by dedicated tests under `src/reflection` and `src/__tests__`:

- `src/reflection/reflection.test.ts`
- `ReflectionAnalyzer` pattern detection, scoring, and thresholds
- `InMemoryReflectionStore` persistence/query behavior and ordering

- `src/reflection/learning-bridge.test.ts`
- tool-stats to workflow-events mapping
- analyzer + bridge integration
- filter/store/callback behavior
- error propagation from `store.save` and `onSummary`

- `src/__tests__/run-reflector.test.ts`
- heuristic dimensions, flags, weighting, and edge cases

- `src/__tests__/run-reflector-llm.test.ts`
- LLM gating modes, merge behavior, prompt fields, clamp behavior, fallback flags

### Observability characteristics
- Reflection callback failures in `run-engine.ts` are intentionally non-fatal and silent.
- No dedicated reflection event is emitted on `eventBus` from this subsystem today.
- Summary persistence/forwarding observability is caller-owned via `onReflectionComplete` and any configured store/handler instrumentation.

## Risks and TODOs
- Event reconstruction fidelity:
- `buildWorkflowEventsFromToolStats` reconstructs events from aggregated tool stats, not raw chronological events. Pattern detection therefore reflects synthesized order, not exact execution traces.

- Silent failure path:
- `run-engine.ts` swallows all errors in reflection callback execution. This protects run delivery but can hide reflection regressions unless callers add their own logging/metrics.

- Storage durability:
- Built-in store is memory-only (`InMemoryReflectionStore`). Production retention/querying requires a custom `RunReflectionStore` implementation.

- Divergent scoring surfaces:
- `ReflectionAnalyzer` (workflow-pattern quality) and `RunReflector` (input/output heuristic + optional LLM) are separate models with different semantics and are not unified in runtime wiring.

- Run identity stability:
- Default run ID for analyzer callback is time-derived and process-local; cross-process/global correlation is caller responsibility.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten to reflect current multi-file reflection subsystem (`RunReflector`, `ReflectionAnalyzer`, store, learning bridge, and run-engine callback integration).
