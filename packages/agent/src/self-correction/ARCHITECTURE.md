# Self-Correction Architecture (`packages/agent/src/self-correction`)

## Scope
This module contains quality control, failure analysis, and learning helpers used by `@dzupagent/agent` runtimes. The scope is limited to code under `src/self-correction` plus the direct hooks it exposes into pipeline and recovery surfaces.

Implemented surfaces in this folder:
- Iterative refinement and node wrapping: `reflection-loop.ts`, `iteration-controller.ts`, `self-correcting-node.ts`, `output-refinement.ts`
- Failure detection and diagnosis: `pipeline-stuck-detector.ts`, `error-detector.ts`, `root-cause-analyzer.ts`, `verification-protocol.ts`, `strategy-selector.ts`
- Learning persistence and retrieval: `adaptive-prompt-enricher.ts`, `trajectory-calibrator.ts`, `post-run-analyzer.ts`, `feedback-collector.ts`, `recovery-feedback.ts`, `learning-dashboard.ts`, `performance-optimizer.ts`, `specialist-registry.ts`
- Runtime bridges: `self-learning-hook.ts`, `self-learning-runtime.ts`, `langgraph-middleware.ts`, `observability-bridge.ts`
- Export barrel: `index.ts`

This document does not describe generic guardrails in `src/guardrails` or orchestration internals outside direct integration points.

## Responsibilities
- Refine generated outputs using model-based critique loops and stop conditions.
- Detect stuck/failure patterns at pipeline level and normalize error signals.
- Provide recovery and strategy-selection memory based on historical outcomes.
- Persist run learnings (lessons/rules/trajectories/feedback) through `BaseStore` namespaces.
- Wrap pipeline and LangGraph execution with best-effort learning hooks.
- Expose analytics-oriented read models (`LearningDashboardService`, `AgentPerformanceOptimizer`) for downstream product/runtime consumers.

## Structure
- `reflection-loop.ts`: drafter/critic iterative loop with score parsing (`parseCriticResponse`) and budget/quality/no-improvement exits.
- `iteration-controller.ts`: non-LLM decision logic for plateau/diminishing/cost-prohibitive stopping.
- `self-correcting-node.ts`: wraps a `NodeExecutor`; skips refinement on error/empty output; returns `SelfCorrectingResult` metadata.
- `output-refinement.ts`: domain-aware (`sql|code|analysis|ops|general`) refinement loop with regression guard and domain auto-detection.
- `pipeline-stuck-detector.ts`: cross-node stuck detection using failure windows, repeated output hashes, and global retry caps.
- `error-detector.ts`: typed error aggregation/correlation with source-based severities and recovery hints.
- `root-cause-analyzer.ts`: heuristic + LLM JSON diagnosis with robust fallback.
- `verification-protocol.ts`: `single|vote|debate|consensus` verification strategies using Jaccard clustering.
- `adaptive-prompt-enricher.ts`: reads rules/errors/lessons/baselines from store and builds bounded markdown enrichment blocks.
- `trajectory-calibrator.ts`: records step rewards, computes baselines, detects suboptimal deviations, stores/prunes run trajectories.
- `post-run-analyzer.ts`: consolidates run analysis into lessons/rules/trajectory/history records.
- `strategy-selector.ts`: records fix outcomes and recommends `targeted|contextual|regenerative` based on historical rates.
- `specialist-registry.ts`: category/risk-driven tuning for model tier, reflection depth, quality thresholds, and verification strategy.
- `performance-optimizer.ts`: sliding-window optimization decisions plus optional persist/load.
- `feedback-collector.ts`: approval feedback capture, action-item extraction, and conversion to lesson/rule-compatible shapes.
- `learning-dashboard.ts`: read-only dashboard aggregation across namespaces.
- `recovery-feedback.ts`: optional persistence of recovery lessons for `RecoveryCopilot`.
- `observability-bridge.ts`: threshold-based correction signals from latency/cost/error/token usage.
- `self-learning-hook.ts`: event callback bridge for `PipelineRuntimeEvent` with internal metrics.
- `self-learning-runtime.ts`: wrapper around `PipelineRuntime` that wires selected self-learning modules.
- `langgraph-middleware.ts`: equivalent best-effort bridge for LangGraph node functions.
- `index.ts`: local barrel exports.

## Runtime and Control Flow
1. Pipeline-native refinement path:
- `createSelfCorrectingExecutor(...)` wraps an existing pipeline `NodeExecutor`.
- Wrapped executor runs original node first.
- If no error and non-empty output, `ReflectionLoop.execute(...)` runs iterative critique/revision.
- Iteration summaries are replayed into `AdaptiveIterationController` to compute cost/score metadata.
- Returns original node shape plus refinement metadata (`refinementIterations`, `scoreHistory`, `exitReason`, `refinementCostCents`).

2. `SelfLearningRuntime` pipeline wrapper:
- Constructor receives `PipelineRuntimeConfig` + `SelfLearningConfig`.
- Optionally instantiates `PipelineStuckDetector`, `TrajectoryCalibrator`, `AdaptivePromptEnricher`, `ErrorDetectionOrchestrator`, `ObservabilityCorrectionBridge`, `PostRunAnalyzer`.
- Builds a `SelfLearningPipelineHook` and chains it with any existing `pipelineConfig.onEvent`.
- Delegates execution/resume/cancel/state to underlying `PipelineRuntime`.
- After `execute()`/`resume()`, `enrichResult()` attaches hook metrics and optionally calls `PostRunAnalyzer.analyze(...)`.

3. LangGraph path:
- `LangGraphLearningMiddleware.wrapNode(nodeId, fn)` wraps each node.
- Before node call: optional enrichment is injected into `systemPromptAddendum` or `_learningContext`.
- After node success: optional trajectory step record + observability metric.
- After node failure: error is recorded, original error is rethrown.
- `onPipelineStart()` resets run trackers; `onPipelineEnd()` runs post-run analysis summary.

4. Recovery feedback loop:
- `RecoveryCopilot` (outside this folder) can consume `RecoveryFeedback`.
- `recover()` retrieves similar lessons before planning and records outcome after execution.

5. Direct pipeline runtime hooks (outside this folder but consumed here):
- `PipelineRuntime` reads `stuckDetector` and `trajectoryCalibrator` hooks from `PipelineRuntimeConfig`.
- Stuck/calibration events are emitted as `PipelineRuntimeEvent` and can be consumed by `SelfLearningPipelineHook`.

## Key APIs and Types
- Refinement:
- `ReflectionLoop.execute(task, initialDraft?, scoreFn?)`
- `AdaptiveIterationController.decide(score, costCents)`
- `createSelfCorrectingExecutor(originalExecutor, drafter, config)`
- `OutputRefinementLoop.refine({ task, output, ... })`

- Failure/verification:
- `PipelineStuckDetector.recordNodeFailure|recordNodeOutput|recordRetry`
- `ErrorDetectionOrchestrator.recordError|recordQualityScore`
- `RootCauseAnalyzer.analyze(params)`
- `VerificationProtocol.verify(agents, judge, task, riskClass)`
- `StrategySelector.recommend(...)` and `recordOutcome(...)`

- Learning/persistence:
- `AdaptivePromptEnricher.enrich(...)`
- `TrajectoryCalibrator.recordStep|detectSuboptimal|storeTrajectory|getNodeBaseline`
- `PostRunAnalyzer.analyze(run)`
- `FeedbackCollector.recordPlanFeedback|recordPublishFeedback|getStats`
- `RecoveryFeedback.recordOutcome|retrieveSimilar|getSuccessRate`
- `LearningDashboardService.getDashboard()`
- `AgentPerformanceOptimizer.recordExecution|getRecommendation|persist|load`
- `SpecialistRegistry.getConfig|getNodeConfig|setOverride`

- Runtime bridges:
- `SelfLearningPipelineHook.createEventHandler|getMetrics`
- `SelfLearningRuntime.execute|resume|getLearningMetrics`
- `LangGraphLearningMiddleware.wrapNode|onPipelineStart|onPipelineEnd|recommendFixStrategy`
- `ObservabilityCorrectionBridge.recordNodeMetric|getSignals|summarize`

## Dependencies
External runtime dependencies used in this module:
- `@langchain/core`
- `@langchain/langgraph` (mainly `BaseStore` typing and store contract)
- Node `crypto` (`pipeline-stuck-detector.ts` output hashing)

Internal package dependencies touched by this folder:
- `../pipeline/*` types/runtime (`PipelineRuntime`, `PipelineRuntimeEvent`, `NodeExecutor`)
- `../recovery/recovery-types.js` (`FailureType`) and recovery integration via `RecoveryCopilot`
- `@dzupagent/core` type imports in `self-learning-runtime.ts`
- `specialist-registry` model tier types consumed by `performance-optimizer`

Store namespace patterns actually used by implementations include:
- `lessons`, `rules`, `errors`, `trajectories/*`, `post_run/*`
- `strategy-selector/outcomes/<nodeId>/<errorType>`
- `recovery/lessons`
- `self_correction/feedback/records`
- `performance_optimizer` (state key: `optimizer_state`)
- `specialist-registry/overrides`

## Integration Points
- Package exports:
- Re-exported from `src/self-correction/index.ts`.
- Re-exported from package root `src/index.ts` under the self-correction section.

- Pipeline runtime integration:
- `src/pipeline/pipeline-runtime-types.ts` includes optional `stuckDetector` and `trajectoryCalibrator` config hooks.
- `src/pipeline/pipeline-runtime.ts` calls these hooks and emits stuck/calibration events.

- Recovery integration:
- `src/recovery/recovery-copilot.ts` accepts optional `RecoveryFeedback` and calls `retrieveSimilar` + `recordOutcome`.

- Agent integration:
- `src/agent/tool-loop-learning.ts` uses `SpecialistRegistry` for feature/risk-based config lookup.

- LangGraph integration:
- `LangGraphLearningMiddleware` is a standalone adapter for node wrapping when not using `PipelineRuntime`.

## Testing and Observability
Current self-correction-focused tests under `src/__tests__` include:
- Core loops and wrappers: `reflection-loop.test.ts`, `iteration-controller.test.ts`, `self-correcting-node.test.ts`, `output-refinement-deep.test.ts`
- Runtime bridges: `self-learning-runtime.test.ts`, `self-learning-hook.test.ts`, `langgraph-middleware.test.ts`, `self-learning-integration.test.ts`
- Failure/strategy modules: `error-detector.test.ts`, `pipeline-stuck-detector.test.ts`, `root-cause-analyzer.test.ts`, `verification-protocol.test.ts`, `strategy-selector.test.ts`, `observability-bridge.test.ts`
- Learning/persistence modules: `adaptive-prompt-enricher.test.ts`, `trajectory-calibrator.test.ts`, `trajectory-calibrator-branches.test.ts`, `post-run-analyzer.test.ts`, `feedback-collector.test.ts`, `learning-dashboard.test.ts`, `performance-optimizer.test.ts`, `recovery-feedback-deep.test.ts`, `self-correction-deep.test.ts`

Observability surfaces in code:
- `PipelineRuntimeEvent` consumption via `SelfLearningPipelineHook` (counts nodes, stuck detections, recoveries, enrichments).
- `ObservabilityCorrectionBridge` signal generation and markdown summary.
- `PostRunAnalyzer` generated run summary text and persisted analysis history.
- `LearningDashboardService` query model for downstream API/UI dashboards.

## Risks and TODOs
- `SelfLearningRuntime` currently initializes `_observabilityBridge` and `_learningConfig` as reserved/internal fields; observability output is not propagated into `SelfLearningRunResult`.
- `SelfLearningRuntime` hook enrichment runs on `pipeline:node_started` callback and increments metrics, but no direct prompt injection path into `PipelineRuntime` node execution context is implemented in this wrapper.
- `SelfLearningRuntime` records trajectory steps with placeholder `runId: 'current'` and `qualityScore: 1.0` on node completion callbacks; richer score/cost capture depends on additional wiring.
- `LangGraphLearningMiddleware` keeps a `nodeScores` map used by `onPipelineEnd`, but wrapped node execution does not currently populate per-node scores.
- `StrategySelector.getHistoricalRates(nodeId)` without `errorType` returns empty by design because namespace enumeration is unavailable via `BaseStore` API.
- `OutputRefinementLoop` is exported and tested, but it is not auto-wired by `SelfLearningRuntime` or `LangGraphLearningMiddleware`; adoption remains opt-in.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

