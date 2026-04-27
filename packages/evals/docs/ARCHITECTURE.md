# @dzupagent/evals Architecture

## Scope
`@dzupagent/evals` is the evaluation and conformance package in `dzupagent/packages/evals`.

It currently contains:
- Legacy evaluation APIs (`EvalScorer` style + `runEvalSuite`) kept for compatibility.
- Enhanced scorer APIs (`Scorer<EvalInput>`), dataset tooling, and concurrent eval runner.
- Benchmark suites and benchmark comparison/trend utilities.
- Adapter contract test framework and built-in contract suites.
- Prompt experiment and prompt optimization workflows.
- Eval and benchmark orchestrators moved from server (`MC-A02`) and now implemented in this package.

Out of scope for this package:
- Model/provider implementations.
- Persistent store implementations (the package consumes store interfaces/contracts).
- Product-level routing/UI concerns.

## Responsibilities
- Define and export evaluation contracts used by evaluators, runners, and orchestrators.
- Execute dataset-driven scoring with configurable concurrency, abort support, and regression checks.
- Provide deterministic and LLM-judge scorer implementations, including domain-specific scoring.
- Provide reusable benchmark suites and result comparison/trend logic.
- Provide adapter conformance test generation, execution, and reporting.
- Provide prompt A/B experimentation and iterative prompt optimization over eval outcomes.
- Orchestrate eval/benchmark run lifecycle via injected run stores and execution targets.

## Structure
Top-level package surface is `src/index.ts` (single public entrypoint compiled by `tsup`).

```text
src/
  index.ts
  types.ts

  # Legacy compatibility surface
  deterministic-scorer.ts
  llm-judge-scorer.ts
  composite-scorer.ts
  eval-runner.ts

  # Dataset + runner
  dataset/eval-dataset.ts
  runner/enhanced-runner.ts
  runner/eval-runner.ts           # re-export shim

  # Scorers
  scorers/deterministic-enhanced.ts
  scorers/llm-judge-enhanced.ts
  scorers/llm-judge-scorer.ts     # 5-dimension scorer with Zod schema
  scorers/evidence-quality-scorer.ts
  scorers/scorer-registry.ts
  scorers/domain-scorer.ts
  scorers/domain-scorer/*
  scorers/{composite,deterministic,llm-judge}.ts  # legacy re-export shims

  # Benchmarks
  benchmarks/benchmark-runner.ts
  benchmarks/benchmark-trend.ts
  benchmarks/benchmark-types.ts    # contract type re-exports
  benchmarks/suites/{code-gen,qa,tool-use,multi-turn,vector-search,self-correction,learning-curve}.ts

  # Contracts
  contracts/contract-types.ts
  contracts/contract-test-generator.ts
  contracts/contract-test-runner.ts
  contracts/contract-test-reporter.ts
  contracts/suites/{vector-store,sandbox,llm-provider,embedding-provider}.ts

  # Prompt systems
  prompt-experiment/prompt-experiment.ts
  prompt-optimizer/prompt-version-store.ts
  prompt-optimizer/prompt-optimizer.ts

  # Orchestration (migrated from server)
  orchestrator/eval-orchestrator.ts
  orchestrator/benchmark-orchestrator.ts

  __tests__/*.test.ts
```

## Runtime and Control Flow
### Legacy eval path
`runEvalSuite(suite, target)`:
- Runs each case with `target(input)`.
- Runs all suite scorers for the case via `Promise.all`.
- Computes per-case aggregate score and pass (`passThreshold`, default `0.7`).
- Returns suite-level aggregate score and pass rate.

### Enhanced eval path
`EvalRunner.evaluateDataset(dataset)`:
- Validates concurrency as finite positive integer.
- Uses `Semaphore` from `@dzupagent/core/orchestration` for bounded parallel entry processing.
- Optionally executes a `target(input, metadata)` for real outputs; otherwise uses `expectedOutput` fallback behavior based on `strict`/`missingTargetFallback`.
- Builds `EvalInput` per scorer, aggregates scorer results per entry, and emits optional progress callbacks.
- Returns report (`entries`, per-scorer averages, overall pass rate/score, duration).

`EvalRunner.regressionCheck(dataset, baseline)`:
- Re-runs dataset and compares per-scorer averages to baseline map.
- Returns regressions or throws in `ciMode`.

### Scoring flow
- Deterministic enhanced scorers: JSON schema, keyword, latency, and cost scoring.
- LLM judging:
  - `createLLMJudge(...)`: criteria-driven scorer with retry/parsing logic.
  - `LlmJudgeScorer`: fixed five dimensions (correctness/completeness/coherence/relevance/safety) validated via Zod.
- `DomainScorer`: domain-specific criteria (`sql`, `code`, `analysis`, `ops`, `general`), with deterministic-only, LLM-only, or combined scoring.
- `ScorerRegistry`: built-ins (`exact-match`, `contains`, `llm-judge`, `evidence_quality`) + runtime registration.

### Benchmark flow
`runBenchmark(suite, target, config?)`:
- Iterates suite dataset and scorer configs.
- Uses deterministic heuristics for deterministic scorer types.
- For `llm-judge` scorer type:
  - Uses real LLM judging when `config.llm` is provided.
  - Falls back to heuristic (or throws if `strict`).
- Produces benchmark result and threshold regressions.

`compareBenchmarks(current, previous)`:
- Computes improved/regressed/unchanged scorer IDs using epsilon comparison.

`BenchmarkTrendStore.trend(...)`:
- Pulls historical runs from store.
- Uses linear-regression slope over recent runs to classify trend (`improving`, `degrading`, `stable`, `insufficient_data`).

### Contract flow
`ContractSuiteBuilder`:
- Builds suites with required/recommended/optional tests and duplicate-ID protection.

`runContractSuite(config)`:
- Optional suite setup.
- Category/test-ID filtering.
- Sequential test execution with per-test timeout wrapper.
- Optional teardown.
- Compliance summarization (percent + level: `full|partial|minimal|none`).

Built-in suites:
- `VECTOR_STORE_CONTRACT`
- `SANDBOX_CONTRACT`
- `LLM_PROVIDER_CONTRACT`
- `EMBEDDING_PROVIDER_CONTRACT`

### Prompt experimentation and optimization
`PromptExperiment.run(variants, dataset)`:
- Requires >=2 variants.
- Uses model invocation + scorers for each dataset entry with bounded concurrency.
- Computes variant metrics, pairwise paired t-test comparisons, winner, and markdown report.

`PromptOptimizer.optimize(...)`:
- Loads active prompt version from `PromptVersionStore`.
- Evaluates baseline prompt on dataset.
- Generates rewrite candidates with meta model.
- Evaluates candidates with eval model + scorers.
- Saves improved versions when score improvement passes threshold.
- Supports rollback/activation/version lineage through `PromptVersionStore`.

### Orchestrator flow
`EvalOrchestrator`:
- Queue/lease-based eval run lifecycle on `EvalRunStore`.
- Handles enqueue, claim, run, retry, cancel, recovery-on-restart, and lease refresh.
- Emits queue metrics via optional `MetricsCollector`.

`BenchmarkOrchestrator`:
- Runs named suites against target IDs through injected executor and `BenchmarkRunStore`.
- Persists runs, compares runs, and manages per-suite baselines.

## Key APIs and Types
Primary public API is exported from `src/index.ts`.

Core exported areas:
- Types:
  - Legacy eval types (`EvalResult`, `EvalScorer`, `EvalSuite`, etc.) re-exported via `types.ts`.
  - Enhanced scorer types (`EvalInput`, `ScorerConfig`, `ScorerResult`, `Scorer`).
  - Orchestrator/run store contract types re-exported from `@dzupagent/eval-contracts`.
- Scorers:
  - Legacy: `DeterministicScorer`, `LLMJudgeScorer`, `CompositeScorer`.
  - Enhanced: `createLLMJudge`, `LlmJudgeScorer`, deterministic scorer factories, `DomainScorer`, `EvidenceQualityScorer`.
  - Registry: `ScorerRegistry`, `defaultScorerRegistry`.
- Runners:
  - `runEvalSuite` (legacy).
  - `EvalRunner` + report formatters (`reportToMarkdown`, `reportToJSON`, `reportToCIAnnotations`).
- Dataset:
  - `EvalDataset`.
- Benchmarks:
  - `runBenchmark`, `compareBenchmarks`, suite constants, trend store, learning-curve tools.
- Contracts:
  - `ContractSuiteBuilder`, `timedTest`, `runContractSuite(s)`, compliance formatters, built-in contract suites.
- Prompt systems:
  - `PromptExperiment`, `PromptVersionStore`, `PromptOptimizer`.
- Orchestrators:
  - `EvalOrchestrator`, `BenchmarkOrchestrator`, and orchestrator config types.

## Dependencies
From `package.json`:
- Direct dependency: `@dzupagent/core`.
- Peer dependency: `zod` (`>=4.0.0`).
- Dev dependencies: `typescript`, `tsup`, `vitest`, `zod`.

Runtime/module imports used in source:
- `@dzupagent/eval-contracts` (types/contracts + orchestrator interfaces).
- `@langchain/core` (prompt experiment, optimizer, domain scorer message/model types).
- `@langchain/langgraph` (`BaseStore` type for prompt version storage).
- Node built-ins: `node:crypto`.

Build configuration (`tsup.config.ts`):
- ESM output, Node 20 target, declaration generation.
- `src/index.ts` as entrypoint.
- Only `zod` marked as external explicitly.

## Integration Points
- `@dzupagent/server` (and other consumers) integrate orchestrators through `EvalOrchestratorLike` / `BenchmarkOrchestratorLike` contracts from `@dzupagent/eval-contracts`.
- Execution targets are injected callbacks (`EvalExecutionTarget`, benchmark `executeTarget`) rather than hard-coded provider/runtime dependencies.
- Contract suites validate adapter implementations by structural behavior, not concrete class imports.
- Prompt systems integrate with LangChain-style chat models and BaseStore-compatible persistence.
- Metric integration is optional through `MetricsCollector` in `EvalOrchestrator`.

## Testing and Observability
Test setup:
- Vitest (`environment: node`, `testTimeout: 60_000`, `hookTimeout: 60_000`).
- Coverage thresholds in config:
  - `statements >= 60`
  - `branches >= 50`
  - `functions >= 50`
  - `lines >= 60`

Current local test footprint:
- `31` `*.test.ts` files under `src/`.
- Broad coverage across runners, scorers, benchmark paths, contract suites/reporting, prompt systems, dataset parsing, and domain scorer modules.

Current local coverage artifact (`coverage/coverage-summary.json`):
- Total statements/lines: `98.74%`
- Functions: `99.07%`
- Branches: `96.00%`

Observability surfaces:
- `EvalOrchestrator` emits queue gauges/counters/histograms when metrics collector is supplied (pending, active, wait time, lifecycle counters).
- `EvalRunner`, `PromptExperiment`, and `PromptOptimizer` expose progress and/or structured report outputs for pipeline/CI visibility.
- Contract and eval report formatters provide markdown/json/CI annotation outputs.

## Risks and TODOs
- Dependency declaration drift risk: source imports `@dzupagent/eval-contracts`, `@langchain/core`, and `@langchain/langgraph`, while `package.json` lists only `@dzupagent/core` (+ `zod` peer). In workspace builds this can be masked by hoisting; for published/isolated installs this should be reconciled.
- Legacy + enhanced API coexistence increases maintenance and naming ambiguity (`LLMJudgeScorer` legacy vs `LlmJudgeScorer` enhanced).
- Benchmark runner uses heuristic fallback for `llm-judge` when no LLM is provided and logs `console.warn`; this can silently reduce benchmark fidelity unless strict mode is enabled.
- `EvalRunner` default non-strict mode can score against `expectedOutput` without executing a real target; useful for fixture checks but can be mistaken for end-to-end validation.
- There are several one-line re-export shim files (`runner/eval-runner.ts`, `scorers/{deterministic,llm-judge,composite}.ts`) that exist for compatibility; any surface cleanup would require a clear deprecation plan.
- README auto-generated overview values in this package can drift from current source/test counts and should be refreshed when docs are regenerated.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

