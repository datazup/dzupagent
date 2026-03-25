# @forgeagent/evals

Evaluation framework for LLM agent outputs. Provides deterministic scorers, LLM-as-judge scorers, composite scoring, dataset management with JSON/JSONL/CSV loaders, a concurrent evaluation runner with regression detection, four built-in benchmark suites, and CI-compatible report formatters.

## Installation

```bash
npm install @forgeagent/evals
```

## Quick Start

```ts
import {
  EvalRunner,
  EvalDataset,
  createKeywordScorer,
  createLLMJudge,
  reportToMarkdown,
} from '@forgeagent/evals'

// Build a dataset
const dataset = EvalDataset.from([
  { id: 'sum-1', input: 'Write a sum function in TypeScript', expectedOutput: 'function sum' },
  { id: 'sum-2', input: 'Write a multiply function', expectedOutput: 'function multiply' },
])

// Create scorers
const keywords = createKeywordScorer({
  required: ['function', 'return'],
  forbidden: ['var'],
})

const judge = createLLMJudge({
  criteria: 'Code correctness and TypeScript best practices',
  llm: (prompt) => model.invoke(prompt),
})

// Run evaluation with concurrency
const runner = new EvalRunner({
  scorers: [keywords, judge],
  concurrency: 5,
  onProgress: (done, total) => console.log(`${done}/${total}`),
})

const report = await runner.evaluateDataset(dataset)
console.log(reportToMarkdown(report))
// Outputs a formatted Markdown table with per-entry and per-scorer results
```

## Scorers

### Deterministic Scorers (no LLM required)

#### DeterministicScorer (legacy)

Supports four modes: `exactMatch`, `contains`, `regex`, and `jsonSchema`.

```ts
import { DeterministicScorer } from '@forgeagent/evals'

const exactMatch = new DeterministicScorer({
  mode: 'exactMatch',
  caseInsensitive: true,
})

const regexScorer = new DeterministicScorer({
  mode: 'regex',
  pattern: /^(function|const)\s+\w+/,
})

const schemaScorer = new DeterministicScorer({
  mode: 'jsonSchema',
  schema: {
    required: ['name', 'version'],
    properties: {
      name: { type: 'string' },
      version: { type: 'string' },
    },
  },
})
```

#### Enhanced Deterministic Scorers

Factory functions that return `Scorer<EvalInput>` instances with richer result types:

```ts
import {
  createJSONSchemaScorer,
  createKeywordScorer,
  createLatencyScorer,
  createCostScorer,
} from '@forgeagent/evals'

// Validate JSON structure
const schema = createJSONSchemaScorer({
  schema: { required: ['id', 'name'], properties: { id: { type: 'string' } } },
})

// Check for required and forbidden keywords
const keywords = createKeywordScorer({
  required: ['export', 'async'],
  forbidden: ['any', 'eval'],
})

// Score based on response latency
const latency = createLatencyScorer({
  maxAcceptableMs: 5000,  // 1.0 at 0ms, 0.0 at 5000ms
})

// Score based on token cost
const cost = createCostScorer({
  maxAcceptableCents: 10,
})
```

### LLM-as-Judge Scorers

#### LLMJudgeScorer (legacy)

Sends a prompt to an LLM and parses the structured JSON response:

```ts
import { LLMJudgeScorer } from '@forgeagent/evals'

const judge = new LLMJudgeScorer({
  rubric: 'Rate the code quality on correctness, style, and documentation',
  llm: (prompt) => model.invoke(prompt),
  scoreRange: '0.0 to 1.0',
})

const result = await judge.score(input, output, reference)
// { score: 0.85, pass: true, reasoning: '...' }
```

#### Enhanced LLM Judge

Supports multi-criteria evaluation with per-criterion scores and custom prompt templates:

```ts
import { createLLMJudge, STANDARD_CRITERIA, CODE_CRITERIA } from '@forgeagent/evals'

// Single rubric string
const simpleJudge = createLLMJudge({
  criteria: 'Overall quality and correctness',
  llm: (prompt) => model.invoke(prompt),
})

// Multi-criteria with built-in presets
const codeJudge = createLLMJudge({
  criteria: CODE_CRITERIA,  // correctness, style, efficiency, documentation
  llm: (prompt) => model.invoke(prompt),
  maxRetries: 2,
})

const result = await codeJudge.score({
  input: 'Write a binary search',
  output: generatedCode,
  reference: referenceImplementation,
})
// { scorerId, scores: [{ criterion, score, reasoning }...], aggregateScore, passed, durationMs }
```

**Built-in criteria presets:**
- `STANDARD_CRITERIA` -- general-purpose evaluation criteria
- `CODE_CRITERIA` -- code-specific criteria (correctness, style, efficiency, documentation)
- `FIVE_POINT_RUBRIC` -- 5-point grading rubric
- `TEN_POINT_RUBRIC` -- 10-point grading rubric

### CompositeScorer

Combines multiple scorers with weighted aggregation:

```ts
import { CompositeScorer, DeterministicScorer, LLMJudgeScorer } from '@forgeagent/evals'

const composite = new CompositeScorer({
  scorers: [
    { scorer: deterministicScorer, weight: 0.3 },
    { scorer: llmJudgeScorer, weight: 0.7 },
  ],
})
```

## Datasets

`EvalDataset` is an immutable, filterable, sampleable collection of evaluation entries. Supports loading from JSON arrays, JSONL (one object per line), and CSV files.

```ts
import { EvalDataset } from '@forgeagent/evals'

// Create from an array
const dataset = EvalDataset.from([
  { id: 'q1', input: 'What is 2+2?', expectedOutput: '4', tags: ['math'] },
  { id: 'q2', input: 'Capital of France?', expectedOutput: 'Paris', tags: ['geography'] },
], { name: 'my-dataset', version: '1.0' })

// Load from file formats
const fromJson = EvalDataset.fromJSON('[{"id":"q1","input":"..."}]')
const fromJsonl = EvalDataset.fromJSONL('{"id":"q1","input":"..."}\n{"id":"q2","input":"..."}')
const fromCsv = EvalDataset.fromCSV('id,input,expectedOutput,tags\nq1,"Hello, world",Hi,greeting')
// CSV supports quoted fields with commas; tags are semicolon-separated

// Filter by tags (AND logic) or IDs
const mathOnly = dataset.filter({ tags: ['math'] })
const specific = dataset.filter({ ids: ['q1'] })

// Reproducible sampling with seeded PRNG (Fisher-Yates + Mulberry32)
const sample = dataset.sample(10, 42)  // 10 entries, seed=42

// Inspect
dataset.size         // 2
dataset.allTags()    // ['geography', 'math']
dataset.metadata     // { name, description, version, createdAt, totalEntries, tags }
```

## Runner

### EvalRunner (enhanced)

Concurrent evaluation runner with progress callbacks, abort support, regression detection, and multiple report output formats.

```ts
import { EvalRunner } from '@forgeagent/evals'

const controller = new AbortController()

const runner = new EvalRunner({
  scorers: [keywordScorer, llmJudge],
  concurrency: 5,         // max parallel evaluations (default: 5)
  signal: controller.signal,  // abort support
  ciMode: false,          // if true, regressionCheck throws on regression
  onProgress: (completed, total, latest) => {
    console.log(`[${completed}/${total}] ${latest.entryId}: ${latest.aggregateScore}`)
  },
})

// Evaluate a dataset
const report = await runner.evaluateDataset(dataset)
// {
//   entries: EvalReportEntry[],
//   byScorerAverage: Map<string, number>,
//   overallPassRate: number,
//   overallAvgScore: number,
//   totalDurationMs: number,
// }

// Check for regressions against a baseline
const baseline = new Map([['keyword-scorer', 0.85], ['llm-judge', 0.75]])
const regression = await runner.regressionCheck(dataset, baseline)
// { passed: boolean, regressions: string[], averages: Map<string, number> }
```

### runEvalSuite (legacy)

Simple suite runner for the legacy `EvalScorer` interface:

```ts
import { runEvalSuite } from '@forgeagent/evals'

const result = await runEvalSuite(suite, async (input) => agent.generate(input))
// { suiteId, timestamp, results, aggregateScore, passRate }
```

### Report Formatters

```ts
import { reportToMarkdown, reportToJSON, reportToCIAnnotations } from '@forgeagent/evals'

// Markdown table for PR comments
const md = reportToMarkdown(report)

// JSON for programmatic consumption
const json = reportToJSON(report)

// GitHub Actions annotations for CI
const annotations = reportToCIAnnotations(report)
// ['::error::Eval entry "q1" failed (score=0.40): keyword-scorer=0.20', ...]
```

## Benchmarks

Four built-in benchmark suites for evaluating different agent capabilities:

```ts
import {
  runBenchmark,
  compareBenchmarks,
  CODE_GEN_SUITE,
  QA_SUITE,
  TOOL_USE_SUITE,
  MULTI_TURN_SUITE,
} from '@forgeagent/evals'

// Run a benchmark
const result = await runBenchmark(CODE_GEN_SUITE, async (input) => {
  return agent.generate(input)
})
// { suiteId, timestamp, scores: Record<string, number>,
//   passedBaseline: boolean, regressions: string[] }

// Compare two runs
const previous = await runBenchmark(CODE_GEN_SUITE, oldAgent)
const current = await runBenchmark(CODE_GEN_SUITE, newAgent)
const comparison = compareBenchmarks(current, previous)
// { improved: string[], regressed: string[], unchanged: string[] }
```

| Suite | Category | Description |
|-------|----------|-------------|
| `CODE_GEN_SUITE` | `code-gen` | Code generation quality and correctness |
| `QA_SUITE` | `qa` | Question answering accuracy |
| `TOOL_USE_SUITE` | `tool-use` | Tool selection and usage correctness |
| `MULTI_TURN_SUITE` | `multi-turn` | Multi-turn conversation coherence |

Each suite defines dataset entries, scorers, and baseline thresholds. Benchmark scoring uses keyword overlap for deterministic scorers and existence checks for LLM judge placeholders.

## CI Integration

Integrate evaluations into your CI pipeline:

```ts
// ci-eval.ts
import { EvalRunner, EvalDataset, createKeywordScorer, reportToCIAnnotations } from '@forgeagent/evals'

const dataset = EvalDataset.fromJSON(await readFile('evals/dataset.json', 'utf-8'))

const runner = new EvalRunner({
  scorers: [createKeywordScorer({ required: ['function'] })],
  ciMode: true,  // throws on regression
})

const baseline = new Map([['keyword-scorer', 0.9]])
await runner.regressionCheck(dataset, baseline)
// Throws if any scorer regresses below baseline
```

## API Reference

### Classes

- `DeterministicScorer` -- rule-based scoring (exactMatch, contains, regex, jsonSchema)
- `LLMJudgeScorer` -- LLM-based evaluation with rubrics
- `CompositeScorer` -- weighted combination of multiple scorers
- `EvalRunner` -- concurrent evaluation runner with regression detection
- `EvalDataset` -- immutable, filterable, sampleable evaluation dataset

### Factory Functions

- `createLLMJudge(config)` -- enhanced LLM judge with multi-criteria support
- `createJSONSchemaScorer(config)` -- JSON schema validation scorer
- `createKeywordScorer(config)` -- required/forbidden keyword scorer
- `createLatencyScorer(config)` -- latency-based scorer
- `createCostScorer(config)` -- cost-based scorer
- `runEvalSuite(suite, target)` -- legacy suite runner
- `runBenchmark(suite, target)` -- benchmark suite runner
- `compareBenchmarks(current, previous)` -- compare two benchmark results
- `reportToMarkdown(report)` -- format report as Markdown table
- `reportToJSON(report)` -- format report as JSON string
- `reportToCIAnnotations(report)` -- format as GitHub Actions annotations

### Constants

- `STANDARD_CRITERIA` -- general-purpose evaluation criteria
- `CODE_CRITERIA` -- code-specific criteria
- `FIVE_POINT_RUBRIC` -- 5-point grading rubric
- `TEN_POINT_RUBRIC` -- 10-point grading rubric
- `CODE_GEN_SUITE` -- code generation benchmark
- `QA_SUITE` -- question answering benchmark
- `TOOL_USE_SUITE` -- tool usage benchmark
- `MULTI_TURN_SUITE` -- multi-turn conversation benchmark

### Types

**Core:** `EvalResult`, `EvalScorer`, `EvalCase`, `EvalSuite`, `EvalRunResult`, `EvalInput`, `ScorerConfig`, `ScorerResult`, `Scorer`

**Scorers:** `DeterministicScorerConfig`, `LLMJudgeConfig`, `CompositeScorerConfig`, `LLMJudgeEnhancedConfig`, `JSONSchemaScorerConfig`, `KeywordScorerConfig`, `LatencyScorerConfig`, `CostScorerConfig`, `JudgeCriterion`

**Runner:** `EvalRunnerConfig`, `EvalReportEntry`, `EvalReport`, `RegressionResult`

**Dataset:** `EvalEntry`, `DatasetMetadata`

**Benchmarks:** `BenchmarkCategory`, `BenchmarkSuite`, `BenchmarkResult`, `BenchmarkComparison`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@forgeagent/core` | `0.1.0` | Core infrastructure |

## License

MIT
