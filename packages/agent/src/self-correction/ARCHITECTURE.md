# Self-Correction Architecture (`packages/agent/src/self-correction`)

## Scope
This document covers the code in `packages/agent/src/self-correction` and direct wiring points that consume it inside the same package.

In-scope implementation surfaces:
- Iterative refinement: `reflection-loop.ts`, `iteration-controller.ts`, `self-correcting-node.ts`, `output-refinement.ts`, `output-refinement-engine.ts`, `output-refinement-prompts.ts`, `output-refinement-types.ts`
- Failure and verification: `pipeline-stuck-detector.ts`, `error-detector.ts`, `root-cause-analyzer.ts`, `verification-protocol.ts`, `strategy-selector.ts`, `observability-bridge.ts`
- Learning and persistence: `adaptive-prompt-enricher.ts`, `trajectory-calibrator.ts`, `post-run-analyzer.ts`, `recovery-feedback.ts`, `feedback-collector.ts`, `learning-dashboard.ts`, `performance-optimizer.ts`, `specialist-registry.ts`, `learning-candidate.ts`, `learning-candidate-service.ts`, `recovery-lesson-types.ts`
- Runtime bridges: `self-learning-hook.ts`, `self-learning-runtime.ts`, `langgraph-middleware.ts`
- Local barrel for internal/test imports: `index.ts`

Out of scope:
- General guardrails in `src/guardrails`
- Pipeline executor internals in `src/pipeline` except where this module integrates through published hooks/events
- Product-level API/UI adapters in consuming apps

## Responsibilities
- Provide refinement loops that improve generated outputs using critique-and-revise iteration with budget and convergence controls.
- Detect and classify failure/stuck patterns, then derive recovery-oriented strategy signals.
- Persist and retrieve learning artifacts (lessons, rules, trajectories, feedback records, candidate audit trails) through `BaseStore` namespaces.
- Supply wrappers/middleware that connect learning behavior to `PipelineRuntime` and LangGraph node execution.
- Expose optimization and dashboard read models to help consumers inspect quality/cost/error trends.
- Keep learning operations best-effort so failures in enrichment/persistence do not fail the core execution path.

## Structure
- `reflection-loop.ts`: model-driven drafter/critic loop; parses critic output via `parseCriticResponse`; exits on quality, no-improvement, budget, max-iteration, or error.
- `iteration-controller.ts`: score/cost trend controller (`AdaptiveIterationController`) with plateau and diminishing-returns logic.
- `self-correcting-node.ts`: `createSelfCorrectingExecutor` wrapper around a pipeline `NodeExecutor`; skips refinement for error/empty output and returns `SelfCorrectingResult` metadata.
- `output-refinement.ts`: `OutputRefinementLoop` for domain-aware post-generation polishing with regression detection.
- `output-refinement-engine.ts`: low-level critique/refine model invocation helpers.
- `output-refinement-prompts.ts`: domain prompts, response parsing, token/cost estimates, and domain detection heuristics.
- `output-refinement-types.ts`: public refinement contracts.
- `pipeline-stuck-detector.ts`: cross-node stuck detection based on failure windows, repeated output hashes, and retry ceilings.
- `error-detector.ts`: typed error stream aggregation and correlation (`ErrorDetectionOrchestrator`).
- `root-cause-analyzer.ts`: heuristic + LLM JSON root-cause analysis with parsing fallback.
- `verification-protocol.ts`: `single|vote|debate|consensus` verification paths plus Jaccard clustering.
- `strategy-selector.ts`: persistence-backed recommendation of `targeted|contextual|regenerative` fix strategy.
- `observability-bridge.ts`: threshold-based correction signals from latency/cost/error-rate/token-budget metrics.
- `adaptive-prompt-enricher.ts`: composes markdown enrichment from rules/warnings/lessons/baselines.
- `trajectory-calibrator.ts`: records step rewards, computes baselines, detects suboptimal deviations, stores/prunes trajectories.
- `post-run-analyzer.ts`: consolidates run outcomes into lessons/rules/trajectory/history records.
- `recovery-feedback.ts`: candidate-staged recovery lesson flow with optional durable promotion and validation-driven auto-actions.
- `recovery-lesson-types.ts`: shared `RecoveryLesson` type to break circular dependencies.
- `learning-candidate.ts`: candidate model, audit trail shape, promotion policy defaults, in-memory candidate store.
- `learning-candidate-service.ts`: framework-agnostic operator service for list/get/promote/reject/recordValidation.
- `feedback-collector.ts`: approval-gate feedback recording and translation into lesson/rule-compatible items.
- `learning-dashboard.ts`: read-only aggregation service over learning namespaces.
- `performance-optimizer.ts`: sliding-window recommendation engine for model tier/reflection/quality/cost settings.
- `specialist-registry.ts`: category/risk-class configuration registry with optional store-backed overrides.
- `self-learning-hook.ts`: event-driven hook consuming `PipelineRuntimeEvent`.
- `self-learning-runtime.ts`: `PipelineRuntime` wrapper that wires selected self-learning components.
- `langgraph-middleware.ts`: node wrapper middleware for LangGraph-style execution.
- `index.ts`: internal barrel for folder-level imports.

## Runtime and Control Flow
1. Node-level self-correction flow (`createSelfCorrectingExecutor`):
- Run original node executor.
- Short-circuit on `error` or empty output.
- Build/refine task description from node metadata or `evaluationCriteria`.
- Run `ReflectionLoop.execute(...)`.
- Replay reflection history into `AdaptiveIterationController.decide(...)` to compute final cost/iteration metadata.
- Return `SelfCorrectingResult` with refined output and refinement telemetry.

2. `SelfLearningRuntime` wrapping flow:
- Accept `PipelineRuntimeConfig` + `SelfLearningConfig`.
- Optionally instantiate: `PipelineStuckDetector`, `TrajectoryCalibrator`, `ErrorDetectionOrchestrator`, `AdaptivePromptEnricher`, `ObservabilityCorrectionBridge`, `PostRunAnalyzer`.
- Build `SelfLearningPipelineHook` callbacks and chain them with existing `pipelineConfig.onEvent`.
- Construct underlying `PipelineRuntime` with merged config and optional forwarded `recoveryCopilot`.
- On `execute()`/`resume()`: reset metrics, delegate to runtime, then attach `learningMetrics` and optional `analysis` (`PostRunAnalyzer`).

3. LangGraph middleware flow (`LangGraphLearningMiddleware`):
- `onPipelineStart(runId)` resets run trackers.
- `wrapNode(nodeId, fn)` returns a node wrapper:
- Before node: optional enrichment via `AdaptivePromptEnricher` and state injection into `systemPromptAddendum` or `_learningContext`.
- After success: optional trajectory step record + observability metric.
- After failure: error classification and rethrow original error.
- `onPipelineEnd(...)` runs post-run consolidation through `PostRunAnalyzer`.
- `recommendFixStrategy(...)` delegates to `StrategySelector`.

4. Recovery feedback flow:
- `RecoveryCopilot` (outside this folder) calls `RecoveryFeedback.retrieveSimilar(...)` before plan selection.
- After execution/escalation, `recordRecoveryFeedback(...)` builds a `RecoveryLesson`, stages it via `RecoveryFeedback.recordOutcome(...)`, and appends audit metadata.
- Candidate review/promotion/rejection is performed through `RecoveryFeedback` APIs or `LearningCandidateService`.

5. Persistence interaction pattern:
- Most write paths are best-effort and swallow store errors.
- Store keys/namespaces are module-specific and are read back by enrichers/dashboard/selector services.

## Key APIs and Types
- Iterative refinement:
- `ReflectionLoop.execute(task, initialDraft?, scoreFn?)`
- `parseCriticResponse(response)`
- `AdaptiveIterationController.decide(score, costCents)`
- `createSelfCorrectingExecutor(originalExecutor, drafter, config)`
- `OutputRefinementLoop.refine(...)`

- Failure analysis and verification:
- `PipelineStuckDetector.recordNodeFailure(...)`, `recordNodeOutput(...)`, `recordRetry(...)`
- `ErrorDetectionOrchestrator.recordError(...)`, `recordQualityScore(...)`
- `RootCauseAnalyzer.analyze(...)`, `classifyHeuristic(...)`
- `VerificationProtocol.verify(...)`, `vote(...)`, `consensus(...)`
- `StrategySelector.recommend(...)`, `recordOutcome(...)`, `getHistoricalRates(...)`
- `ObservabilityCorrectionBridge.recordNodeMetric(...)`, `getSignals()`, `summarize()`

- Learning persistence and curation:
- `AdaptivePromptEnricher.enrich(...)`, `enrichWithBudget(...)`
- `TrajectoryCalibrator.recordStep(...)`, `detectSuboptimal(...)`, `storeTrajectory(...)`, `getNodeBaseline(...)`
- `PostRunAnalyzer.analyze(...)`, `getRecentAnalyses(...)`
- `RecoveryFeedback.recordOutcome(...)`, `promoteCandidate(...)`, `rejectCandidate(...)`, `recordValidationOutcome(...)`, `retrieveSimilar(...)`, `getSuccessRate(...)`
- `LearningCandidateService.listPending(...)`, `get(...)`, `promote(...)`, `reject(...)`, `recordValidation(...)`
- `FeedbackCollector.recordPlanFeedback(...)`, `recordPublishFeedback(...)`, `getStats(...)`, `feedbackToLessons(...)`, `feedbackToRules(...)`
- `LearningDashboardService.getDashboard(...)`
- `AgentPerformanceOptimizer.recordExecution(...)`, `getRecommendation(...)`, `persist()`, `load()`
- `SpecialistRegistry.getConfig(...)`, `getNodeConfig(...)`, `setOverride(...)`

- Runtime bridge types:
- `SelfLearningConfig`, `SelfLearningRunResult`
- `SelfLearningHookConfig`, `HookMetrics`
- `LangGraphLearningConfig`, `LearningRunMetrics`, `WrapNodeOptions`
- `RecoveryLesson`, `LearningCandidate`, `CandidatePromotionPolicy`

## Dependencies
External dependencies used directly by this module:
- `@langchain/core` (`BaseChatModel`, `HumanMessage`, `SystemMessage`)
- `@langchain/langgraph` (`BaseStore`)
- Node builtin `node:crypto` (`createHash` in stuck detection)

Internal dependencies used directly by this module:
- `../pipeline/pipeline-runtime.js` and `../pipeline/pipeline-runtime-types.js`
- `../recovery/recovery-types.js` (for `FailureType`)
- `../utils/exact-optional.js` (`omitUndefined`)
- `@dzupagent/core/pipeline` (pipeline node/checkpoint types)
- `@dzupagent/core/utils` (`defaultLogger`, `FrameworkLogger`)

Package-level dependency context (`packages/agent/package.json`):
- Runtime deps include `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/runtime-contracts`, and `@dzupagent/security`.
- Peer deps relevant to this folder: `@langchain/core`, `@langchain/langgraph`, `zod`.

Store namespace patterns present in current implementation:
- Enricher defaults: `lessons`, `rules`, `trajectories`, `errors`
- `TrajectoryCalibrator`: `<ns>/steps/<nodeId>`, `<ns>/runs`
- `PostRunAnalyzer`: `<ns>/trajectories`, `<ns>/lessons`, `<ns>/rules`, `<ns>/history`
- `StrategySelector`: `<ns>/outcomes/<nodeId>/<errorType>`
- `RecoveryFeedback`: default `recovery/lessons`
- `FeedbackCollector`: default `self_correction/feedback/records`
- `SpecialistRegistry`: `<ns>/overrides`
- `AgentPerformanceOptimizer`: `<ns>/optimizer_state`

## Integration Points
- Published package subpath:
- `packages/agent/package.json` exports `./self-correction` -> `dist/self-correction.js`.
- `tsup.config.ts` builds this from `src/self-correction.ts`.

- Internal barrels:
- `src/self-correction.ts` is the consumer-facing subpath barrel.
- `src/self-correction/index.ts` is used by local/test imports.

- Pipeline runtime integration:
- `SelfLearningRuntime` wraps `PipelineRuntime` and composes `onEvent` handlers.
- It can auto-create `PipelineStuckDetector` and forwards optional `recoveryCopilot`.
- `SelfLearningPipelineHook` consumes events like `pipeline:node_started`, `pipeline:node_completed`, `pipeline:node_failed`, `pipeline:stuck_detected`, `pipeline:recovery_*`, `pipeline:completed`, `pipeline:failed`.

- Recovery subsystem integration:
- `src/recovery/recovery-copilot.ts` accepts optional `RecoveryFeedback`.
- `src/recovery/feedback-recorder.ts` builds lessons and records staged candidate audit entries.
- `src/recovery/lesson-boosts.ts` consumes `RecoveryLesson` history.

- Agent tool-loop integration:
- `src/agent/tool-loop-learning.ts` optionally uses `SpecialistRegistry` for category/risk-based config.

- LangGraph integration:
- `LangGraphLearningMiddleware` is independent of `PipelineRuntime` and wraps node functions directly.

## Testing and Observability
Self-correction module tests under `src/__tests__` currently include:
- Refinement/iteration: `reflection-loop.test.ts`, `iteration-controller.test.ts`, `self-correcting-node.test.ts`, `output-refinement-deep.test.ts`
- Runtime bridges: `self-learning-hook.test.ts`, `self-learning-runtime.test.ts`, `langgraph-middleware.test.ts`, `self-learning-integration.test.ts`
- Failure and strategy: `pipeline-stuck-detector.test.ts`, `error-detector.test.ts`, `root-cause-analyzer.test.ts`, `verification-protocol.test.ts`, `strategy-selector.test.ts`, `observability-bridge.test.ts`
- Learning persistence and analytics: `adaptive-prompt-enricher.test.ts`, `trajectory-calibrator.test.ts`, `trajectory-calibrator-branches.test.ts`, `post-run-analyzer.test.ts`, `feedback-collector.test.ts`, `learning-dashboard.test.ts`, `performance-optimizer.test.ts`
- Candidate/recovery flows: `recovery-feedback-deep.test.ts`, `learning-candidate-auto-promote.test.ts`, `specialist-registry.test.ts`, `recovery-copilot.test.ts`
- Broad integration sanity: `self-correction-deep.test.ts`

Observability surfaces implemented in this folder:
- Event-derived metrics in `SelfLearningPipelineHook` (`nodes*`, enrichments, stuck/recovery counters, total duration).
- Threshold signal generation in `ObservabilityCorrectionBridge` (`latency_spike`, `cost_overrun`, `error_rate_high`, `token_budget_warning`, `quality_drop` type support).
- Markdown run summary in `PostRunAnalyzer.buildSummary(...)`.
- Dashboard aggregation output in `LearningDashboardService`.

## Risks and TODOs
- `SelfLearningRuntime` computes enrichment content on `pipeline:node_started`, but current `PipelineRuntime` event callbacks are observational; this wrapper does not inject that content back into node execution input.
- `SelfLearningRuntime` trajectory callback records placeholder values (`runId: 'current'`, `qualityScore: 1.0`, `tokenCost: 0`, `errorCount: 0`), so stored trajectory data is currently coarse unless additional wiring is provided.
- `SelfLearningRuntime` creates `_observabilityBridge` and keeps `_learningConfig`, but correction signals are not exposed in `SelfLearningRunResult`.
- `LangGraphLearningMiddleware` keeps `nodeScores` for post-run analysis input, but wrapped nodes do not currently set per-node scores; `onPipelineEnd` therefore depends on external caller data for meaningful scoring.
- `StrategySelector.getHistoricalRates(nodeId)` without `errorType` returns empty by design because `BaseStore` namespace enumeration is unavailable in this path.
- `LearningDashboardService` expects namespaces such as `skills`, `packs_loaded`, and `feedback`; producers in this folder do not fully standardize those writes, so some dashboard sections can be sparse without external writers or aligned namespace config.
- `OutputRefinementLoop` is exported and tested but is not auto-wired by `SelfLearningRuntime` or `LangGraphLearningMiddleware`; callers must opt in explicitly.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

