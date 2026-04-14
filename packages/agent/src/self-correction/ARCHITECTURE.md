# Self-Correction Module Architecture (`packages/agent/src/self-correction`)

## Scope

This folder implements the self-correction and self-learning subsystem for `@dzupagent/agent`.

It covers four major concerns:

- iterative output quality improvement
- failure detection, diagnosis, and strategy adaptation
- memory-backed learning across runs
- middleware/runtime integration for pipeline and LangGraph execution

This module is exposed both:

- locally via [`index.ts`](./index.ts)
- package-wide via [`packages/agent/src/index.ts`](../index.ts)

## Design Principles

Across almost all components, the same design principles are used:

- Best-effort learning: store/learning failures should not break the main execution path.
- Sidecar architecture: most modules are adapters around existing runtime behavior, not replacements for core pipeline execution.
- Stateless APIs over persisted memory: module behavior is deterministic from inputs plus persisted history in `BaseStore` namespaces.
- Optional composition: almost every component can be used independently.

## Module Inventory

### Quality and Refinement

- [`reflection-loop.ts`](./reflection-loop.ts)
  - Drafter/critic iterative refinement loop using two chat models.
  - Exit reasons: `quality_met`, `max_iterations`, `budget_exhausted`, `no_improvement`, `error`.

- [`iteration-controller.ts`](./iteration-controller.ts)
  - Cost/quality-aware stopping policy with plateau and diminishing-returns detection.

- [`self-correcting-node.ts`](./self-correcting-node.ts)
  - Wraps any `NodeExecutor` with `ReflectionLoop` and emits enriched node results.

- [`output-refinement.ts`](./output-refinement.ts)
  - Domain-aware (sql/code/analysis/ops/general) critique+refine loop.
  - Regression-safe: keeps original output if refinement degrades score.

### Error, Verification, and Recovery Signals

- [`error-detector.ts`](./error-detector.ts)
  - Aggregates typed error events (`stuck_detector`, `timeout`, `resource_exhaustion`, etc.) with severities and correlations.

- [`root-cause-analyzer.ts`](./root-cause-analyzer.ts)
  - Heuristic + LLM root cause analysis; falls back safely to heuristics when parse/invoke fails.

- [`verification-protocol.ts`](./verification-protocol.ts)
  - Multi-agent verification strategies: `single`, `vote`, `debate`, `consensus`.

- [`pipeline-stuck-detector.ts`](./pipeline-stuck-detector.ts)
  - Pipeline-level stuck detection from node failures, repeated identical outputs, and retry budgets.

- [`recovery-feedback.ts`](./recovery-feedback.ts)
  - Persists and retrieves recovery lessons used by `RecoveryCopilot`.

- [`strategy-selector.ts`](./strategy-selector.ts)
  - Chooses fix escalation path (`targeted`, `contextual`, `regenerative`) from historical outcomes.

### Learning Data Plane

- [`adaptive-prompt-enricher.ts`](./adaptive-prompt-enricher.ts)
  - Builds node-specific prompt addenda from rules/errors/lessons/baselines.

- [`trajectory-calibrator.ts`](./trajectory-calibrator.ts)
  - Tracks node quality trajectories and flags suboptimal runs versus historical baselines.

- [`post-run-analyzer.ts`](./post-run-analyzer.ts)
  - Consolidates run outcomes into lessons/rules/trajectory records.

- [`feedback-collector.ts`](./feedback-collector.ts)
  - Converts approval-gate user feedback into actionable lessons/rules.

- [`learning-dashboard.ts`](./learning-dashboard.ts)
  - Read-only aggregator for dashboard/monitoring payloads.

- [`performance-optimizer.ts`](./performance-optimizer.ts)
  - Suggests model tier/reflection/budget adjustments from execution history.

- [`specialist-registry.ts`](./specialist-registry.ts)
  - Feature-category and risk-class policy registry (model tier, reflection depth, verification strategy).

### Runtime and Middleware Integration

- [`self-learning-hook.ts`](./self-learning-hook.ts)
  - Event-driven hook for `PipelineRuntimeEvent` dispatch and run metrics.

- [`self-learning-runtime.ts`](./self-learning-runtime.ts)
  - Composition wrapper around `PipelineRuntime` that wires enrichers, detectors, analyzers, and hook chaining.

- [`langgraph-middleware.ts`](./langgraph-middleware.ts)
  - Equivalent integration surface for LangGraph node functions (`wrapNode`, `onPipelineStart`, `onPipelineEnd`).

### Barrel

- [`index.ts`](./index.ts)
  - Local export barrel for all self-correction/self-learning primitives.

## Feature Matrix

| Feature | Primary Components | Description |
|---|---|---|
| Drafter/Critic refinement | `ReflectionLoop`, `createSelfCorrectingExecutor` | Iterative scoring and revision with budget/quality stop conditions. |
| Cost-aware stopping | `AdaptiveIterationController` | Stops based on target met, budget pressure, plateau, diminishing returns. |
| Domain-aware polish | `OutputRefinementLoop` | Domain-specific critiques and non-destructive acceptance policy. |
| Failure aggregation | `ErrorDetectionOrchestrator` | Normalizes errors, severity, recovery hints, and temporal correlation. |
| Root-cause diagnosis | `RootCauseAnalyzer` | LLM diagnosis with JSON parsing hardening and heuristic fallback. |
| Multi-agent validation | `VerificationProtocol` | Vote/consensus protocols and risk-to-strategy mapping. |
| Cross-node stuck detection | `PipelineStuckDetector` | Detects retry storms, repeated output loops, and runaway retries. |
| Recovery memory | `RecoveryFeedback` | Stores outcome lessons for future strategy boosting. |
| Strategy adaptation | `StrategySelector` | Historical success-rate based strategy recommendation. |
| Prompt enrichment | `AdaptivePromptEnricher` | Injects rules/warnings/lessons/baselines into node prompt context. |
| Trajectory baselining | `TrajectoryCalibrator` | Baseline comparison for step-level quality drift/suboptimal events. |
| Run consolidation | `PostRunAnalyzer` | Persists trajectories, lessons, and rules from completed runs. |
| Human feedback capture | `FeedbackCollector` | Approval/rejection feedback extraction and conversion to learning artifacts. |
| Dashboard aggregation | `LearningDashboardService` | API-ready trends and overview metrics from learning namespaces. |
| Auto-tuning hints | `AgentPerformanceOptimizer` | Model/reflection/token-budget recommendations from observed history. |
| Category routing policy | `SpecialistRegistry` | Per-category defaults + risk adjustments + optional runtime overrides. |
| Pipeline integration | `SelfLearningRuntime`, `SelfLearningPipelineHook` | Runtime wrapper and callback dispatch for native pipeline engine. |
| LangGraph integration | `LangGraphLearningMiddleware` | Same learning lifecycle for LangGraph node execution. |

## End-to-End Flows

## 1) Native Pipeline Runtime + Self-Learning Runtime

1. `SelfLearningRuntime` is constructed with `PipelineRuntimeConfig` and `SelfLearningConfig`.
2. It creates optional modules (`PipelineStuckDetector`, `TrajectoryCalibrator`, `AdaptivePromptEnricher`, `PostRunAnalyzer`, `ObservabilityCorrectionBridge`).
3. It creates a `SelfLearningPipelineHook` and chains its event handler with any existing `pipelineConfig.onEvent`.
4. On `execute()` or `resume()`, pipeline events feed hook metrics and callbacks.
5. After completion/failure, `enrichResult()` runs post-run analysis best-effort and returns `SelfLearningRunResult`.

Runtime touchpoints in pipeline engine:

- `stuckDetector` integration in [`pipeline-runtime.ts`](../pipeline/pipeline-runtime.ts)
- `trajectoryCalibrator` integration in [`pipeline-runtime.ts`](../pipeline/pipeline-runtime.ts)
- self-learning runtime event types in [`pipeline-runtime-types.ts`](../pipeline/pipeline-runtime-types.ts)

## 2) LangGraph Middleware Learning Loop

1. Wrap each node with `middleware.wrapNode(nodeId, fn)`.
2. Before execution, middleware attempts enrichment and injects content into `systemPromptAddendum` or `_learningContext`.
3. After success, middleware records trajectory + observability metrics.
4. On failure, middleware records error detector signal, then rethrows original error.
5. `onPipelineEnd()` runs `PostRunAnalyzer` and returns summary of lessons/rules created.

This gives a parallel self-learning path for LangGraph users without requiring `PipelineRuntime`.

## 3) Recovery Feedback Loop

1. `RecoveryCopilot` optionally receives `RecoveryFeedback`.
2. Before plan creation, it loads similar lessons via `retrieveSimilar()`.
3. Strategy confidences are adjusted by historical outcomes.
4. After execution, it writes a new `RecoveryLesson` via `recordOutcome()`.

Integration point: [`packages/agent/src/recovery/recovery-copilot.ts`](../recovery/recovery-copilot.ts)

## Store Namespace Model

Common namespaces used by this folder (defaults; many are configurable):

- `lessons`
- `rules`
- `errors`
- `trajectories/runs`
- `trajectories/steps/<nodeId>`
- `post_run/{history,lessons,rules,trajectories}`
- `strategy-selector/outcomes/<nodeId>/<errorType>`
- `recovery/lessons`
- `self_correction/feedback/records`
- `performance_optimizer/optimizer_state`

Namespacing behavior:

- `LangGraphLearningMiddleware` prefixes with `tenantId` when provided.
- `SelfLearningRuntime` uses `namespace` (default `['self-learning']`) and appends domain suffixes.

## Usage Examples

## 1) Iterative refinement for a plain text task

```ts
import { ReflectionLoop } from '@dzupagent/agent'

const loop = new ReflectionLoop(drafterModel, criticModel, {
  maxIterations: 3,
  qualityThreshold: 0.85,
  costBudgetCents: 40,
})

const result = await loop.execute('Write a rollout plan for zero-downtime migrations')
console.log(result.finalOutput)
console.log(result.exitReason)
```

## 2) Wrap a pipeline node with self-correction

```ts
import { createSelfCorrectingExecutor } from '@dzupagent/agent'

const wrappedExecutor = createSelfCorrectingExecutor(nodeExecutor, drafterModel, {
  critic: criticModel,
  qualityThreshold: 0.8,
  maxIterations: 3,
  minImprovement: 0.02,
})
```

## 3) Run native pipeline with self-learning runtime wrapper

```ts
import { SelfLearningRuntime } from '@dzupagent/agent'

const runtime = new SelfLearningRuntime(
  {
    definition,
    nodeExecutor,
    onEvent: (e) => console.log(e.type),
  },
  {
    store,
    taskType: 'crud',
    riskClass: 'standard',
    enableLearning: true,
  },
)

const run = await runtime.execute({ input: 'Create user profile feature' })
console.log(run.learningMetrics)
console.log(run.analysis?.summary)
```

## 4) LangGraph node wrapping + pipeline end analysis

```ts
import { LangGraphLearningMiddleware } from '@dzupagent/agent'

const middleware = new LangGraphLearningMiddleware({
  store,
  tenantId: 'tenant-a',
  taskType: 'dashboard',
  riskClass: 'sensitive',
})

const wrappedNode = middleware.wrapNode('generate', generateNode)

await middleware.onPipelineStart('run-42')
const out = await wrappedNode(state)
const summary = await middleware.onPipelineEnd({
  runId: 'run-42',
  overallScore: 0.91,
  approved: true,
})
```

## 5) Capture rejection feedback and turn it into reusable rules

```ts
import { FeedbackCollector } from '@dzupagent/agent'

const collector = new FeedbackCollector({ store })

const record = await collector.recordPublishFeedback({
  runId: 'run-7',
  approved: false,
  feedback: 'Must add input validation. Should include retry logic.',
  featureCategory: 'crud',
  riskClass: 'standard',
})

const rules = collector.feedbackToRules(record)
// persist `rules` into your rules namespace for future enrichment
```

## References in Other Packages

Direct class-level self-correction consumption is mainly inside `@dzupagent/agent`, but there are important cross-package references and usage paths:

- `@dzupagent/codegen`
  - Uses `PipelineRuntime` from `@dzupagent/agent` in [`packages/codegen/src/pipeline/pipeline-executor.ts`](../../../codegen/src/pipeline/pipeline-executor.ts).
  - This means codegen workflows can leverage runtime config surfaces that include stuck/calibration hooks from self-correction types.

- `@dzupagent/agent-adapters`
  - Also uses `PipelineRuntime` in [`packages/agent-adapters/src/workflow/adapter-workflow.ts`](../../../agent-adapters/src/workflow/adapter-workflow.ts).
  - Adapter workflows inherit the same pipeline runtime extension points.

- `@dzupagent/evals`
  - Includes benchmark suites that mirror self-correction and post-run learning behavior:
  - [`packages/evals/src/benchmarks/suites/self-correction.ts`](../../../evals/src/benchmarks/suites/self-correction.ts)
  - [`packages/evals/src/benchmarks/suites/learning-curve.ts`](../../../evals/src/benchmarks/suites/learning-curve.ts)

Within `@dzupagent/agent`, explicit integration points are:

- package export surface in [`packages/agent/src/index.ts`](../index.ts)
- runtime type/config hooks in [`packages/agent/src/pipeline/pipeline-runtime-types.ts`](../pipeline/pipeline-runtime-types.ts)
- runtime execution hooks in [`packages/agent/src/pipeline/pipeline-runtime.ts`](../pipeline/pipeline-runtime.ts)
- tool-loop specialist routing in [`packages/agent/src/agent/tool-loop-learning.ts`](../agent/tool-loop-learning.ts)
- recovery feedback wiring in [`packages/agent/src/recovery/recovery-copilot.ts`](../recovery/recovery-copilot.ts)

## Test Coverage

Self-correction module behavior is heavily tested in `packages/agent/src/__tests__` with 20 targeted/integration files and about 490 `it(...)` cases.

### Coverage by module

| Module | Test File | Approx `it(...)` Count | Highlights |
|---|---|---:|---|
| `AdaptivePromptEnricher` | `adaptive-prompt-enricher.test.ts` | 17 | source ordering, filtering, token budget truncation |
| `ErrorDetectionOrchestrator` | `error-detector.test.ts` | 31 | source severity mapping, correlation windows, history behavior |
| `FeedbackCollector` | `feedback-collector.test.ts` | 37 | extraction keywords, stats aggregation, record retention |
| `AdaptiveIterationController` | `iteration-controller.test.ts` | 23 | plateau/diminishing/cost-prohibitive/target exits |
| `LangGraphLearningMiddleware` | `langgraph-middleware.test.ts` | 29 | wrap semantics, best-effort failures, lifecycle behavior |
| `LearningDashboardService` | `learning-dashboard.test.ts` | 31 | trend math, overview counts, store-failure resilience |
| `ObservabilityCorrectionBridge` | `observability-bridge.test.ts` | 34 | thresholds, severities, sliding-window error rate |
| `AgentPerformanceOptimizer` | `performance-optimizer.test.ts` | 28 | tier upgrade/downgrade, reflection policy, persistence |
| `PipelineStuckDetector` | `pipeline-stuck-detector.test.ts` | 21 | node failures, identical outputs, retry ceilings |
| `PostRunAnalyzer` | `post-run-analyzer.test.ts` | 17 | lesson/rule generation, baseline comparison, history retrieval |
| `ReflectionLoop` + parser | `reflection-loop.test.ts` | 16 | critic parsing, exit reasons, scoring behavior |
| `RootCauseAnalyzer` | `root-cause-analyzer.test.ts` | 23 | heuristic categories, parse fallback, context handling |
| `createSelfCorrectingExecutor` | `self-correcting-node.test.ts` | 12 | wrapper behavior, metadata, passthrough/error semantics |
| `SelfLearningPipelineHook` | `self-learning-hook.test.ts` | 37 | event dispatch map, metrics, callback isolation |
| `SelfLearningRuntime` | `self-learning-runtime.test.ts` | 24 | module wiring, toggles, result enrichment, handler chaining |
| `SpecialistRegistry` | `specialist-registry.test.ts` | 29 | defaults, risk adjustments, overrides, node-level config |
| `StrategySelector` | `strategy-selector.test.ts` | 15 | recommendation logic, thresholds, attempt suggestions |
| `TrajectoryCalibrator` | `trajectory-calibrator.test.ts` | 16 | baseline computation, suboptimal detection, pruning |
| `VerificationProtocol` | `verification-protocol.test.ts` | 21 | similarity, vote/consensus behavior, strategy mapping |
| Cross-component loop | `self-learning-integration.test.ts` | 29 | multi-run learning, tenant isolation, dashboard + feedback integration |

### Coverage gaps

- No dedicated unit test file currently targets `OutputRefinementLoop`.
- No dedicated unit test file currently targets `RecoveryFeedback`.

Both modules are exported and documented, but their behavior currently relies on code inspection and indirect architecture intent rather than direct automated tests.

## Current Integration Status Notes

- `SelfLearningRuntime` creates `_observabilityBridge` but currently does not expose or consume it deeply in `enrichResult()`.
- `OutputRefinementLoop` is implemented and exported, but is not currently wired into default runtime paths.
- `RecoveryFeedback` is an optional dependency path through `RecoveryCopilot`, not a default always-on path.

## Summary

`self-correction` is a broad, modular subsystem that mixes runtime quality control, reliability signals, and persistent learning. The strongest parts today are:

- robust event-driven integration (`SelfLearningRuntime`, `LangGraphLearningMiddleware`)
- comprehensive store-backed learning data model (`PostRunAnalyzer`, `AdaptivePromptEnricher`, `TrajectoryCalibrator`)
- strong test depth on most components

The main follow-up opportunity is to add direct tests and first-class runtime wiring for `OutputRefinementLoop` and `RecoveryFeedback` to make the module surface uniformly exercised.
