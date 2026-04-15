# @dzupagent/evals Architecture

## 1. Purpose and Scope

`@dzupagent/evals` is the evaluation subsystem in DzupAgent for:

- scoring model/agent outputs
- running dataset-based evaluations with concurrency controls
- running benchmark suites with baseline regression checks
- validating adapter implementations via contract test suites
- running prompt A/B experiments and iterative prompt optimization loops

The package currently contains two API generations:

- **Legacy API**: `EvalScorer`, `EvalSuite`, `runEvalSuite`
- **Enhanced API**: `Scorer<EvalInput>`, `EvalDataset`, `EvalRunner`, benchmark/contract/prompt systems

Both are exported from `src/index.ts` for backward compatibility.

---

## 2. High-Level Module Map

```text
packages/evals/src
├── types.ts                          # shared legacy + enhanced scorer types
├── index.ts                          # public exports
│
├── deterministic-scorer.ts           # legacy deterministic scorer
├── llm-judge-scorer.ts               # legacy LLM judge scorer
├── composite-scorer.ts               # legacy composite scorer
├── eval-runner.ts                    # legacy suite runner
│
├── dataset/
│   └── eval-dataset.ts               # immutable dataset + JSON/JSONL/CSV loaders
│
├── runner/
│   └── enhanced-runner.ts            # concurrent runner + regression + formatters
│
├── scorers/
│   ├── deterministic-enhanced.ts     # JSON schema / keyword / latency / cost scorers
│   ├── llm-judge-enhanced.ts         # configurable multi-criteria LLM judge
│   ├── llm-judge-scorer.ts           # 5-dimension Zod-validated LLM judge
│   ├── scorer-registry.ts            # registry + built-in scorer factories
│   ├── domain-scorer.ts              # domain-aware composite scorer
│   └── domain-scorer/*               # domain configs, deterministic checks, helpers
│
├── benchmarks/
│   ├── benchmark-runner.ts           # suite execution + compare
│   └── suites/*                      # code-gen, qa, tool-use, multi-turn, etc.
│
├── contracts/
│   ├── contract-test-generator.ts    # fluent suite builder
│   ├── contract-test-runner.ts       # compliance runner
│   ├── contract-test-reporter.ts     # markdown/json/CI output
│   └── suites/*                      # vector-store, sandbox, llm, embedding contracts
│
├── prompt-experiment/
│   └── prompt-experiment.ts          # prompt A/B testing + paired t-test
│
└── prompt-optimizer/
    ├── prompt-version-store.ts       # prompt version persistence + activation/rollback
    └── prompt-optimizer.ts           # candidate generation + eval loop
```

---

## 3. Core Data Contracts

### 3.1 Legacy contracts (`types.ts`)

- `EvalScorer`: `score(input, output, reference?) -> EvalResult`
- `EvalSuite`: cases + scorers + optional pass threshold
- `EvalRunResult`: per-case scorer results + suite aggregates

### 3.2 Enhanced contracts (`types.ts`)

- `EvalInput`: includes `input`, `output`, optional `reference`, `tags`, `latencyMs`, `costCents`, metadata
- `ScorerConfig`: scorer identity and metadata (`id`, `name`, `type`, `threshold`, etc.)
- `ScorerResult`: criterion-level scores + aggregate score + pass + duration + optional cost
- `Scorer<TInput>`: typed scoring interface

### 3.3 Dataset contracts (`dataset/eval-dataset.ts`)

- `EvalEntry`: single test item (`id`, `input`, optional `expectedOutput`, `tags`, metadata)
- `EvalDataset`: immutable wrapper with:
  - `from`, `fromJSON`, `fromJSONL`, `fromCSV`
  - `filter({tags, ids})`
  - deterministic `sample(count, seed)` using Mulberry32 + Fisher-Yates
  - metadata (`totalEntries`, tag inventory, version info)

---

## 4. Execution Architecture

### 4.1 Legacy execution flow

```text
EvalSuite (cases + scorers)
   -> runEvalSuite(target)
      -> target(input) per case
      -> scorer.score(...) for each scorer
      -> per-case average
      -> suite aggregate score + passRate
```

Key traits:

- full `Promise.all` parallelism over cases and scorers
- fixed aggregation: arithmetic mean of scorer scores
- case pass: `aggregateScore >= passThreshold` (default `0.7`)

### 4.2 Enhanced execution flow (`runner/enhanced-runner.ts`)

```text
EvalDataset + Scorers + (optional) target
   -> EvalRunner.evaluateDataset()
      -> bounded concurrency via Semaphore
      -> output source:
           target(...) output, OR expectedOutput fallback (configurable)
      -> scorer.score(EvalInput)
      -> entry pass: all scorers passed
      -> report build:
           per-scorer averages + overall avg + pass rate + duration
```

Key runtime controls:

- `concurrency` validation (must be finite positive integer)
- `AbortSignal` cancellation checks before/after semaphore and scorer loops
- missing target behavior:
  - `strict: true` -> throw if `target` absent
  - non-strict default -> fallback to `expectedOutput` (or empty string)
  - `missingTargetFallback: "error"` -> throw in non-strict mode if target missing
- regression mode:
  - `regressionCheck(dataset, baselineMap)` compares scorer averages to baseline
  - in `ciMode`, regression throws error

---

## 5. Scoring Subsystem

### 5.1 Legacy scorers

- `DeterministicScorer` (`exactMatch`, `contains`, `regex`, `jsonSchema`)
- `LLMJudgeScorer` (single prompt, expects JSON with `score/pass/reasoning`)
- `CompositeScorer` (weighted average of legacy scorers)

### 5.2 Enhanced deterministic scorers (`scorers/deterministic-enhanced.ts`)

- `createJSONSchemaScorer`
- `createKeywordScorer`
- `createLatencyScorer`
- `createCostScorer`

All return `Scorer<EvalInput>` with criterion breakdown and timings.

### 5.3 Enhanced LLM judges

### `createLLMJudge` (`scorers/llm-judge-enhanced.ts`)

- criteria can be string or array of weighted criteria
- prompt template customizable with placeholders
- retries on parse failure
- parses JSON array of criterion results
- weighted aggregate score, default pass threshold effectively `0.5`

### `LlmJudgeScorer` (`scorers/llm-judge-scorer.ts`)

- fixed 5 dimensions: correctness, completeness, coherence, relevance, safety
- uses Zod schema validation for structured output
- supports dimension weights, anchors, retries, token usage callback
- dual API:
  - `score(EvalInput) -> ScorerResult`
  - `score(input, output, reference?) -> JudgeScorerResult`
- fallback on total parse/call failure: neutral `0.5` across dimensions

### 5.4 Registry (`scorers/scorer-registry.ts`)

- runtime scorer factory registry
- built-ins: `exact-match`, `contains`, `llm-judge`
- supports custom registration/unregistration
- `defaultScorerRegistry` singleton exported

### 5.5 Domain scorer (`scorers/domain-scorer.ts`)

Domain-aware composite evaluator for:

- `sql`
- `code`
- `analysis`
- `ops`
- `general`

Per criterion, it can use:

- deterministic check only
- LLM judge only
- combined mode (40% deterministic + 60% LLM)

Additional capabilities:

- `DomainScorer.detectDomain(input)` using regex pattern matching
- `DomainScorer.createAutoDetect(model)` to auto-select domain per input
- domain configs can be customized or weight-overridden via constructor params

---

## 6. Benchmark Subsystem

Files: `benchmarks/benchmark-types.ts`, `benchmarks/benchmark-runner.ts`, `benchmarks/suites/*`

Main concepts:

- `BenchmarkSuite`: dataset + scorer configs + baseline thresholds
- `runBenchmark`: runs target function against suite and computes per-scorer averages
- `compareBenchmarks`: diff current vs previous by scorer (`improved/regressed/unchanged`)

Built-in suites:

- `CODE_GEN_SUITE`
- `QA_SUITE`
- `TOOL_USE_SUITE`
- `MULTI_TURN_SUITE`
- `VECTOR_SEARCH_SUITE`
- `SELF_CORRECTION_SUITE` (+ 15 predefined correction scenarios across 7 categories)
- learning curve tooling (`runLearningCurveBenchmark`, `createLearningCurveSuite`)

Notable runtime behavior:

- `runBenchmark` executes dataset entries sequentially
- deterministic benchmark scoring is keyword-overlap style (heuristic)
- `llm-judge` scorer in benchmarks:
  - uses real LLM judge when `config.llm` is provided
  - falls back to non-empty heuristic (`0.5`) without LLM unless `strict: true`

---

## 7. Contract Testing Subsystem

Files: `contracts/*`

Purpose: conformance testing of adapter implementations against required/recommended/optional capabilities.

Core components:

- `ContractSuiteBuilder`:
  - fluent suite construction (`required`, `recommended`, `optional`)
  - duplicate-id prevention
- `timedTest` helper:
  - duration measurement + error capture
- `runContractSuite` / `runContractSuites`:
  - sequential execution (avoids adapter-state conflicts)
  - optional filtering by category/test IDs
  - per-test timeout support
- compliance reporters:
  - markdown, json, GitHub Actions annotations, badges, summaries

Built-in contract suites:

- `VECTOR_STORE_CONTRACT`
- `SANDBOX_CONTRACT`
- `LLM_PROVIDER_CONTRACT`
- `EMBEDDING_PROVIDER_CONTRACT`

Compliance level logic:

- `full`: no required/recommended failures
- `partial`: all required pass, some recommended fail
- `minimal`: some required pass
- `none`: no required tests pass

---

## 8. Prompt Evaluation and Optimization Subsystems

### 8.1 Prompt Experiment (`prompt-experiment/prompt-experiment.ts`)

`PromptExperiment` runs A/B (or A/B/C/...) system prompt comparisons.

Flow:

1. For each variant, invoke model for each dataset entry
2. score outputs with provided scorers
3. compute per-variant aggregates (`avgScore`, `passRate`, latency, cost)
4. run pairwise **paired t-tests** over per-entry score differences
5. determine best variant and whether winner is statistically significant
6. output structured report + markdown renderer

Runtime controls:

- bounded concurrency with semaphore
- abort support
- progress callback per variant

### 8.2 Prompt Version Store (`prompt-optimizer/prompt-version-store.ts`)

Persistence layer over a LangGraph `BaseStore`:

- save version (+ optional eval scores)
- activate/deactivate
- rollback (creates new active version from target content)
- compare versions (line-level added/removed + score delta when available)
- list prompt keys and versions

### 8.3 Prompt Optimizer (`prompt-optimizer/prompt-optimizer.ts`)

Iterative optimization loop:

1. load active prompt version by `promptKey`
2. evaluate baseline prompt on dataset
3. build meta-prompt from scorer averages + worst failures
4. ask `metaModel` to generate candidate rewrites
5. evaluate each candidate with `evalModel` + scorers
6. accept best candidate only if `improvement >= minImprovement`
7. persist accepted version and continue until stop condition

Exit reasons:

- `improved`
- `no_improvement`
- `max_rounds`
- `aborted`
- `error`

---

## 9. Feature Summary

| Area | Features | Main Files |
|---|---|---|
| Dataset | Immutable dataset, filtering, deterministic sampling, JSON/JSONL/CSV loading | `dataset/eval-dataset.ts` |
| Enhanced runner | Concurrency limits, abort, progress callbacks, strict/non-strict target policies, regression checks, report formatters | `runner/enhanced-runner.ts` |
| Deterministic scoring | Schema, keyword, latency, cost scoring | `scorers/deterministic-enhanced.ts` |
| LLM judging | configurable criteria judge + 5-dim validated judge with retries and usage tracking | `scorers/llm-judge-enhanced.ts`, `scorers/llm-judge-scorer.ts` |
| Registry | Built-in and custom scorer factory registration | `scorers/scorer-registry.ts` |
| Domain quality | SQL/code/analysis/ops/general domain scoring with deterministic + LLM hybrid | `scorers/domain-scorer.ts`, `scorers/domain-scorer/*` |
| Benchmarks | reusable suites, baseline checks, run comparison, self-correction and learning-curve scenarios | `benchmarks/*` |
| Contracts | adapter conformance builder/runner/reporter + built-in contracts | `contracts/*` |
| Prompt experimentation | multi-variant prompt testing with paired significance testing | `prompt-experiment/prompt-experiment.ts` |
| Prompt optimization | iterative rewrite/eval/store loop with version history | `prompt-optimizer/*` |

---

## 10. How to Use (Current APIs)

### 10.1 Enhanced evaluation runner (recommended for new code)

```ts
import {
  EvalDataset,
  EvalRunner,
  createKeywordScorer,
  createLLMJudge,
  reportToMarkdown,
} from '@dzupagent/evals';

const dataset = EvalDataset.from([
  { id: 't1', input: 'Write a sum function', expectedOutput: 'function sum' },
  { id: 't2', input: 'Write a multiply function', expectedOutput: 'function multiply' },
]);

const keywordScorer = createKeywordScorer({
  id: 'keywords',
  required: ['function'],
  forbidden: ['var'],
});

const judge = createLLMJudge({
  id: 'judge',
  criteria: 'Correctness and clarity',
  llm: async (prompt) => myJudgeModel(prompt),
});

const runner = new EvalRunner({
  scorers: [keywordScorer, judge],
  concurrency: 4,
  target: async (input) => {
    const output = await myGenerationTarget(input);
    return { output };
  },
});

const report = await runner.evaluateDataset(dataset);
console.log(reportToMarkdown(report));
```

### 10.2 Regression gate in CI

```ts
const baseline = new Map<string, number>([
  ['keywords', 0.85],
  ['judge', 0.72],
]);

const result = await runner.regressionCheck(dataset, baseline);
if (!result.passed) {
  throw new Error(result.regressions.join('\n'));
}
```

Use `ciMode: true` in runner config if you want `regressionCheck` to throw automatically.

### 10.3 Benchmark suites

```ts
import { runBenchmark, CODE_GEN_SUITE, createBenchmarkWithJudge } from '@dzupagent/evals';

const cfg = createBenchmarkWithJudge({
  llm: async (prompt) => myJudgeModel(prompt),
});

const benchmark = await runBenchmark(
  CODE_GEN_SUITE,
  async (input) => myGenerationTarget(input),
  cfg,
);

console.log(benchmark.passedBaseline, benchmark.scores, benchmark.regressions);
```

### 10.4 Contract testing for adapters

```ts
import {
  runContractSuite,
  VECTOR_STORE_CONTRACT,
  complianceToMarkdown,
} from '@dzupagent/evals';

const report = await runContractSuite({
  suite: VECTOR_STORE_CONTRACT,
  adapter: myVectorStoreAdapter,
  testTimeoutMs: 30_000,
});

console.log(report.complianceLevel, report.compliancePercent);
console.log(complianceToMarkdown(report));
```

### 10.5 Domain-aware scoring

```ts
import { DomainScorer } from '@dzupagent/evals';

const scorer = new DomainScorer({
  domain: 'code',
  model: myLangChainChatModel, // optional but recommended for llm criteria
  passThreshold: 0.6,
});

const result = await scorer.score({
  input: 'Write a secure login handler',
  output: generatedCode,
});

console.log(result.aggregateScore, result.domain, result.criterionResults);
```

### 10.6 Prompt A/B experiment

```ts
import { PromptExperiment, EvalDataset, createKeywordScorer } from '@dzupagent/evals';

const experiment = new PromptExperiment({
  model: myLangChainChatModel,
  scorers: [createKeywordScorer({ required: ['function'] })],
  concurrency: 3,
});

const report = await experiment.run(
  [
    { id: 'a', name: 'Baseline', systemPrompt: 'You are helpful.' },
    { id: 'b', name: 'Strict', systemPrompt: 'You are concise and strict about correctness.' },
  ],
  EvalDataset.from([{ id: '1', input: 'Write a TS add function' }]),
);

console.log(report.bestVariant, report.significantWinner);
console.log(report.toMarkdown());
```

### 10.7 Prompt optimization loop

```ts
import { PromptOptimizer, PromptVersionStore } from '@dzupagent/evals';

const versionStore = new PromptVersionStore({
  store: myLangGraphBaseStore,
});

const optimizer = new PromptOptimizer({
  metaModel: myMetaModel,
  evalModel: myEvalModel,
  scorers: myScorers,
  versionStore,
  maxCandidates: 3,
  maxRounds: 3,
  minImprovement: 0.02,
});

const result = await optimizer.optimize({
  promptKey: 'assistant/system',
  dataset: myEvalDataset,
});

console.log(result.improved, result.exitReason, result.scoreImprovement);
```

---

## 11. Extension Points

1. **Custom scorers**
   Implement `Scorer<EvalInput>` and pass into `EvalRunner`, `PromptExperiment`, or `PromptOptimizer`.

2. **Custom scorer registry entries**
   Register factories via `ScorerRegistry.register(type, description, factory)`.

3. **Custom benchmark suites**
   Create `BenchmarkSuite` objects with domain-specific datasets and thresholds.

4. **Custom contract suites**
   Use `ContractSuiteBuilder` with required/recommended/optional tests for new adapter types.

5. **Custom domain configs**
   `DomainScorer` supports custom criteria and weight overrides.

---

## 12. Design Notes and Current Tradeoffs

- The package keeps both legacy and enhanced APIs; this supports compatibility but increases surface area.
- `EvalRunner` default non-strict mode can run without a target by using `expectedOutput`, useful for static regression checks but not a full system test.
- Benchmark deterministic scoring is intentionally lightweight and heuristic; use LLM judge mode for higher-fidelity benchmarking.
- Prompt subsystems depend on LangChain model/store abstractions (`BaseChatModel`, `BaseStore`).
- Contract suites are implementation-agnostic by checking minimal interface shapes instead of importing concrete adapter types.

---

## 13. Test Coverage Footprint

`src/__tests__` includes focused coverage for:

- dataset parsing/filter/sampling behavior
- enhanced and legacy runners
- enhanced deterministic and LLM scorers
- scorer registry behavior
- benchmark execution/comparison and LLM judge fallbacks
- self-correction and learning-curve suites
- contract suites and compliance reporting
- domain scorer helpers/config logic
- prompt experiment flow

This gives strong behavior-level confidence for the current architecture.

---

## 14. Feature-to-Test Traceability

This section maps implemented features to the test files that currently validate them.

| Feature Area | What Is Covered | Related Tests |
|---|---|---|
| Legacy deterministic/LLM/composite scorers | mode behavior, parsing/failure paths, weighted composition | `src/__tests__/scorers.test.ts` |
| Legacy suite runner (`runEvalSuite`) | per-case scoring, aggregate score, pass rate, empty cases | `src/__tests__/eval-runner.test.ts`, `src/__tests__/scorers.test.ts` |
| `EvalDataset` creation/parsing/filtering/sampling | `from`, `fromJSON`, `fromJSONL`, `fromCSV`, tag/id filtering, deterministic sampling, metadata/tags | `src/__tests__/dataset.test.ts`, `src/__tests__/dataset-and-registry-coverage.test.ts` |
| Enhanced deterministic scorers | JSON schema validation, keyword semantics, latency/cost interpolation, criterion breakdown, IDs/duration | `src/__tests__/enhanced-scorers.test.ts`, `src/__tests__/deterministic-enhanced-scorers.test.ts` |
| Enhanced configurable LLM judge (`createLLMJudge`) | criteria modes, weighted aggregates, prompt template usage, retries/fallback, score clamping | `src/__tests__/enhanced-scorers.test.ts`, `src/__tests__/deterministic-enhanced-scorers.test.ts` |
| 5-dim LLM judge (`LlmJudgeScorer`) | Zod schema validation, dimension weighting, retries, fallback, token/cost tracking, prompt content expectations, benchmark integration | `src/__tests__/llm-judge-scorer.test.ts`, `src/__tests__/dataset-and-registry-coverage.test.ts` |
| Scorer registry | built-in types, registration/unregistration, factory creation behavior, missing dependency behavior | `src/__tests__/scorer-registry.test.ts`, `src/__tests__/dataset-and-registry-coverage.test.ts` |
| Domain scorer modules | config cloning/normalization, helper parsing, deterministic domain checks, auto-detect/public contracts | `src/__tests__/domain-scorer-modules.test.ts` |
| Enhanced runner (`EvalRunner`) | target vs expected-output behavior, strict mode, missing-target policies, concurrency bounds, abort flow, progress callback, regression checks | `src/__tests__/eval-runner-enhanced.test.ts`, `src/__tests__/enhanced-runner-coverage.test.ts` |
| Enhanced report formatters | markdown/json/CI annotation generation incl. edge cases | `src/__tests__/eval-runner-enhanced.test.ts`, `src/__tests__/enhanced-runner-coverage.test.ts` |
| Benchmark runner (`runBenchmark`, `compareBenchmarks`) | suite execution, baseline regressions, strict mode for llm-judge, compare deltas, structure validation | `src/__tests__/benchmarks.test.ts`, `src/__tests__/benchmark-runner-coverage.test.ts` |
| Benchmark LLM-judge integration | no-LLM heuristic fallback, strict mode, real LLM judge path, mixed scorer suites, helper config | `src/__tests__/benchmark-llm-judge.test.ts`, `src/__tests__/llm-judge-scorer.test.ts` |
| Self-correction benchmark suite | scenario integrity, categories/difficulty metadata, baseline compatibility and scoring expectations | `src/__tests__/self-correction-benchmark.test.ts` |
| Learning-curve benchmark suite | quality pattern handling, simulated run generation, store accumulation, improving-trend calculation, suite wrapper | `src/__tests__/learning-curve-benchmark.test.ts` |
| Contract framework core | suite builder semantics, timing wrapper, runner filtering/timeouts, compliance calculation, report formatting | `src/__tests__/contracts.test.ts` |
| Built-in sandbox contract behavior | required/recommended/optional checks, adapter behavior and custom extension suite | `src/__tests__/sandbox-contracts.test.ts`, `src/__tests__/contracts.test.ts` |
| Built-in vector-store contract behavior | vector-store conformance and behavior checks, custom extension suite | `src/__tests__/vectorstore-contracts.test.ts`, `src/__tests__/contracts.test.ts` |
| Prompt experiment subsystem | end-to-end experiment execution, variant comparison reporting | `src/__tests__/prompt-experiment.test.ts` |

## 15. Current Coverage Gaps / Risk Notes

- **Prompt optimizer and version store** (`src/prompt-optimizer/*`): there is currently no dedicated `__tests__` module for `PromptOptimizer` and `PromptVersionStore`.
- **Domain scorer integration depth**: domain scorer helper/config logic is tested, but full multi-domain LLM integration behavior is less extensively covered than deterministic/helper paths.
- **Embedding/LLM provider built-in contracts**: core contract framework is tested broadly (`contracts.test.ts`), but there are fewer standalone behavioral test modules compared to sandbox/vector-store.

If feature changes are made in these areas, add targeted tests first to keep regression risk low.
