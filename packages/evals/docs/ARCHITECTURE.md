# @dzupagent/evals Architecture

## Scope
`@dzupagent/evals` is the evaluation package in `dzupagent/packages/evals`.

The package currently includes:
- Legacy eval primitives (`EvalScorer`/`EvalSuite` style) and `runEvalSuite` compatibility flow.
- Enhanced scorer APIs (`Scorer<EvalInput>`), dataset parsing/filtering/sampling, and concurrent eval execution.
- Benchmark execution, baseline comparison, trend analysis, and learning-curve simulation utilities.
- Adapter contract testing toolkit (suite builder, runner, reporters) with built-in suites for vector store, sandbox, LLM provider, and embedding provider adapters.
- Prompt experiment (A/B testing with paired statistics) and prompt optimizer (iterative rewrite + version persistence).
- Eval and benchmark orchestrators with queueing, leasing, retry/cancel/recovery, and regression gate checks.
- CLI regression gate entrypoint (`src/cli/regression-gate.ts`) built into `dist/cli/regression-gate.js`.

Out of scope:
- Concrete model/provider implementations.
- Concrete persistent store implementations (store contracts are injected).
- Product UI or HTTP routing.

## Responsibilities
- Define and export eval contracts and scorer interfaces used by package consumers.
- Execute suite-based and dataset-based evaluations.
- Provide deterministic and LLM-based scoring paths, including domain-specific scoring and evidence-quality scoring.
- Provide reusable benchmark suites and comparison/trend tools for regression tracking.
- Validate adapter behavior via contract suites and compliance reports.
- Support prompt quality workflows (experiment and optimization) using evaluation feedback.
- Orchestrate eval/benchmark runs against injected stores and execution targets.

## Structure
Top-level package entrypoint: `src/index.ts`.
Build config: `tsup.config.ts` (entries: `src/index.ts`, `src/cli/regression-gate.ts`, ESM, Node 20 target).

Key source layout:

```text
src/
  index.ts
  types.ts

  # Legacy compatibility surface
  deterministic-scorer.ts
  llm-judge-scorer.ts
  composite-scorer.ts
  eval-runner.ts

  # Enhanced runtime
  dataset/
    eval-dataset.ts
  runner/
    enhanced-runner.ts
    eval-runner.ts            # shim re-export

  # Scorers
  scorers/
    deterministic-enhanced.ts
    llm-judge-enhanced.ts
    llm-judge-scorer.ts
    evidence-quality-scorer.ts
    domain-scorer.ts
    domain-scorer/{configs,deterministic-checks,helpers,types}.ts
    scorer-registry.ts
    criteria.ts
    {deterministic,llm-judge,composite}.ts  # shim re-exports

  # Benchmarks
  benchmarks/
    benchmark-runner.ts
    benchmark-trend.ts
    benchmark-types.ts
    suites/
      code-gen.ts
      qa.ts
      tool-use.ts
      multi-turn.ts
      vector-search.ts
      learning-curve.ts
      self-correction.ts
      self-correction-suite.ts
      self-correction-scenarios-{a,b}.ts
      self-correction-types.ts

  # Adapter contracts
  contracts/
    contract-types.ts
    contract-test-generator.ts
    contract-test-runner.ts
    contract-test-reporter.ts
    suites/
      vector-store-contract.ts
      sandbox-contract.ts
      llm-provider-contract.ts
      embedding-provider-contract.ts

  # Prompt workflows
  prompt-experiment/
    prompt-experiment.ts
    prompt-experiment-runner.ts
    prompt-experiment-stats.ts
    prompt-experiment-report.ts
    prompt-experiment-types.ts
  prompt-optimizer/
    prompt-version-store.ts
    prompt-optimizer-persistence.ts
    prompt-optimizer-evaluator.ts
    prompt-optimizer-generator.ts
    prompt-optimizer-types.ts
    prompt-optimizer.ts        # shim re-export

  # Orchestration
  orchestrator/
    eval-orchestrator-impl.ts
    eval-orchestrator.ts
    eval-orchestrator-{lease,metrics,runner,recovery,transitions,attempts,cost,errors}.ts
    benchmark-orchestrator.ts

  # CLI
  cli/
    regression-gate.ts

  __tests__/
    *.test.ts
```

## Runtime and Control Flow
### Legacy suite flow
`runEvalSuite(suite, target)`:
- Executes each `EvalCase` through `target(input)`.
- Runs each `EvalScorer` on each output.
- Computes per-case aggregate and suite-level aggregate/pass-rate.

### Enhanced dataset flow
`EvalRunner.evaluateDataset(dataset)`:
- Validates concurrency (`finite positive integer`).
- Uses `Semaphore` from `@dzupagent/core/orchestration` for bounded parallelism.
- For each dataset entry:
  - Calls `target(input, metadata)` when configured.
  - Otherwise falls back to `expectedOutput` when non-strict and fallback policy allows.
  - Builds `EvalInput` and executes all configured scorers.
- Produces `EvalReport` with per-entry results, per-scorer averages, pass-rate, average score, and total duration.

`EvalRunner.regressionCheck(dataset, baselineMap)`:
- Re-runs dataset.
- Compares current scorer averages against baseline map.
- Returns regression details, or throws in `ciMode`.

### Scoring flow
- Legacy scorers:
  - `DeterministicScorer` (`exactMatch`, `contains`, `regex`, `jsonSchema`).
  - `LLMJudgeScorer` (legacy JSON prompt/parse path).
  - `CompositeScorer` (weighted aggregation).
- Enhanced scorers:
  - `createJSONSchemaScorer`, `createKeywordScorer`, `createLatencyScorer`, `createCostScorer`.
  - `createLLMJudge` (criteria-based judge with retry + pinned prompt/model drift warnings).
  - `LlmJudgeScorer` (5-dimension judge with Zod schema validation and token usage tracking).
  - `DomainScorer` with built-in domains: `sql`, `code`, `analysis`, `ops`, `research`, `general`; supports deterministic-only, LLM-only, combined, and auto-detection modes.
  - `EvidenceQualityScorer` for coverage/corroboration/reliability scoring from `metadata.evidence`.
- `ScorerRegistry` provides built-in registry types (`exact-match`, `contains`, `llm-judge`, `evidence_quality`) and runtime registration APIs.

### Benchmark flow
`runBenchmark(suite, target, config?)`:
- Executes suite dataset against target callback.
- Computes scorer averages and baseline threshold regressions.
- Supports strict-mode failure when `llm-judge` scorer is used without an LLM config.

`compareBenchmarks(current, previous)`:
- Computes improved/regressed/unchanged scorer IDs with epsilon handling.

`BenchmarkTrendStore.trend(suiteId, targetId, windowSize)`:
- Pulls run history from a store abstraction.
- Computes linear regression slope over recent runs.
- Classifies trend as `improving`, `degrading`, `stable`, or `insufficient_data`.

### Contract flow
`ContractSuiteBuilder`:
- Builds suites with required/recommended/optional tests and duplicate ID protection.

`runContractSuite(config)`:
- Runs optional suite setup.
- Filters tests by category/test IDs.
- Executes tests sequentially with per-test timeout.
- Runs optional teardown.
- Returns compliance summary (`full|partial|minimal|none`) and detailed report.

Report utilities:
- `complianceToMarkdown`, `complianceToJSON`, `complianceToCIAnnotations`, `complianceBadge`, `complianceSummary`.

### Prompt experiment flow
`PromptExperiment.run(variants, dataset)`:
- Requires at least 2 variants.
- Runs each variant over dataset using configured model and scorers with bounded concurrency.
- Collects per-variant metrics (score, pass-rate, latency, cost).
- Computes pairwise paired t-tests and significance.
- Produces `ExperimentReport` with markdown formatter.

### Prompt optimizer flow
`PromptOptimizer.optimize({ promptKey, dataset, failures? })`:
- Loads active prompt version from `PromptVersionStore`.
- Evaluates baseline prompt via eval model + scorers.
- Generates candidate rewrites via meta model.
- Evaluates candidates, persists improved prompt versions, and activates best version.
- Supports bounded rounds/candidates, minimum improvement threshold, and abort handling.

`PromptVersionStore`:
- Persists versioned prompt records in a `BaseStore` namespace.
- Supports save, activate, rollback, compare, list, and active-version lookup.

### Eval orchestration flow
`EvalOrchestrator`:
- Manages queued run IDs in memory while persisting authoritative state in `EvalRunStore`.
- Startup reconciliation re-queues stale queued/running runs and applies recovery patches for expired leases.
- Claims runs via `LeaseManager`, executes via `RunExecutor`, emits metrics via `QueueMetricsTracker`.
- Supports `queueRun`, `cancelRun`, `retryRun`, `getRun`, `listRuns`, `getQueueStats`.
- Enforces optional cost cap via `assertCostWithinCap` before/after target execution.

### Benchmark orchestration and gate
`BenchmarkOrchestrator`:
- Runs named suites against injected target executor and persists `BenchmarkRunRecord` to `BenchmarkRunStore`.
- Supports run retrieval/listing, run-to-run compare, baseline CRUD, and `regressionGate`.
- `regressionGate` throws `RegressionGateError` when score deltas exceed threshold.

CLI regression gate (`src/cli/regression-gate.ts`):
- Loads current/baseline JSON run records.
- Runs `BenchmarkOrchestrator.regressionGate` with threshold.
- Exits non-zero on regressions or invalid input.

## Key APIs and Types
Public exports are centralized in `src/index.ts`.

Main API groups:
- Types:
  - Legacy eval types (`EvalResult`, `EvalScorer`, `EvalCase`, `EvalSuite`, `EvalRunResult`) re-exported from `@dzupagent/eval-contracts` via `types.ts`.
  - Enhanced scorer types (`EvalInput`, `ScorerConfig`, `ScorerResult`, `Scorer`).
  - Orchestrator and benchmark contract types re-exported from `@dzupagent/eval-contracts`.
- Eval execution:
  - `runEvalSuite`.
  - `EvalRunner`, `reportToMarkdown`, `reportToJSON`, `reportToCIAnnotations`.
  - `EvalDataset`.
- Scorers:
  - Legacy: `DeterministicScorer`, `LLMJudgeScorer`, `CompositeScorer`.
  - Enhanced: deterministic factories, `createLLMJudge`, `LlmJudgeScorer`, criteria presets, `DomainScorer`, `EvidenceQualityScorer`.
  - Registry: `ScorerRegistry`, `defaultScorerRegistry`.
- Benchmarks:
  - `runBenchmark`, `compareBenchmarks`, `createBenchmarkWithJudge`.
  - Suite constants (`CODE_GEN_SUITE`, `QA_SUITE`, `TOOL_USE_SUITE`, `MULTI_TURN_SUITE`, `VECTOR_SEARCH_SUITE`, self-correction suite exports).
  - Trend utilities (`BenchmarkTrendStore`, `InMemoryBenchmarkRunStore`).
  - Learning curve utilities (`runLearningCurveBenchmark`, `createLearningCurveSuite`, etc.).
- Contracts:
  - Builder/runner/reporter helpers.
  - Built-in suite factories and constants.
- Prompt workflows:
  - `PromptExperiment` and related types.
  - `PromptVersionStore`, `PromptOptimizer` and related types.
- Orchestrators:
  - `EvalOrchestrator`, `BenchmarkOrchestrator`, error classes, and config/result types.

## Dependencies
From `packages/evals/package.json`:
- Runtime dependencies:
  - `@dzupagent/core`
  - `@dzupagent/eval-contracts`
- Peer dependency:
  - `zod` (`>=4.0.0`)
- Dev dependencies:
  - `@dzupagent/codegen`
  - `tsup`, `typescript`, `vitest`, `zod`

Observed source imports in `src/`:
- `@dzupagent/core/orchestration` and `@dzupagent/core/utils`.
- `@dzupagent/eval-contracts`.
- `@langchain/core/*` and `@langchain/langgraph` (prompt/domain scoring workflows).
- Node built-ins (`node:crypto`, `node:fs`).

Build/runtime notes:
- `tsup` externalizes `zod` explicitly.
- Package emits ESM only.
- `evals:regression-gate` script runs the built CLI artifact.

## Integration Points
- `@dzupagent/server` and other consumers integrate orchestrators through `EvalOrchestratorLike` and `BenchmarkOrchestratorLike` contracts from `@dzupagent/eval-contracts`.
- Eval and benchmark execution are callback-injected (`EvalExecutionTarget`, benchmark `executeTarget`) rather than hard-coded to specific providers.
- Prompt workflows integrate with LangChain chat model and store abstractions (`BaseChatModel`, `BaseStore`).
- Contract suites are adapter-shape based and avoid direct runtime dependencies on adapter implementation packages.
- Test-only optional integration exists with `@dzupagent/codegen` (`MockSandbox` and `DockerSandbox`) in sandbox contract tests.

## Testing and Observability
Testing:
- Framework: Vitest (`environment: node`, `pool: forks`, single fork, extended timeouts for heavier contract tests).
- Includes: `src/**/*.test.ts`, `src/**/*.spec.ts`.
- Current test file count in package source: `34`.
- Coverage thresholds in `vitest.config.ts`:
  - statements `>= 60`
  - branches `>= 50`
  - functions `>= 50`
  - lines `>= 60`

Coverage artifact status:
- `coverage/coverage-summary.json` exists locally.
- The latest local summary reports total coverage around:
  - statements/lines `92.28%`
  - functions `90.72%`
  - branches `92.96%`

Observability:
- `EvalOrchestrator` exposes queue stats and emits optional `MetricsCollector` counters/gauges/histograms (`forge_eval_queue_*` metrics).
- Eval, contract, and prompt workflows provide machine-friendly report outputs (JSON, CI annotations, markdown) for pipeline visibility.
- Regression gate CLI provides non-zero exit behavior for CI enforcement.

## Risks and TODOs
- Dependency declaration risk: source imports `@langchain/core` and `@langchain/langgraph`, but they are not declared in `packages/evals/package.json` dependencies/peers. Workspace hoisting can hide this for local builds.
- API surface complexity: legacy and enhanced scorer APIs coexist with similarly named types/classes, which increases migration and maintenance overhead.
- Benchmark fallback behavior: non-strict benchmark runs can downgrade `llm-judge` scoring to heuristics when no LLM is provided.
- Eval fallback behavior: `EvalRunner` non-strict mode can score against `expectedOutput` without executing a real target.
- Domain scoring calibration: `DomainScorer` assumes normalized criterion scores, but `research` deterministic criterion currently emits a `0..10` style value in config; this can skew aggregate behavior unless normalized.
- Coverage blind spot in local artifact: CLI files and several orchestrator helpers have lower line coverage in the latest summary despite passing package thresholds.
- Generated metrics in `README.md` and docs can drift from current code/test counts if not regenerated together.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
