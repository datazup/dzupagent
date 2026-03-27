# 08 -- Evaluation and Testing Framework

> **Domain:** Quality assurance for LLM-powered agent systems
> **Packages:** `@dzipagent/evals`, `@dzipagent/testing`
> **Priority:** P1 (core testing) / P2 (benchmarks, advanced CI)
> **Estimated effort:** 68 hours across 10 features
> **Dependencies:** `@dzipagent/core` (event bus, model registry, store interfaces), `@langchain/core` (BaseChatModel, messages)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Current State Analysis](#2-current-state-analysis)
3. [Feature Specifications](#3-feature-specifications)
   - F1: Scorer Interface (P1, 4h)
   - F2: LLM-as-Judge Scorer (P1, 8h)
   - F3: Deterministic Scorers (P1, 4h)
   - F4: Eval Dataset (P1, 4h)
   - F5: Eval Runner (P1, 8h)
   - F6: LLM Recorder (P1, 8h)
   - F7: Mock Models (P1, 4h)
   - F8: Integration Test Harness (P1, 8h)
   - F9: Benchmark Suite (P2, 8h)
   - F10: CI/CD Integration (P1, 4h)
4. [Data Models](#4-data-models)
5. [Data Flow Diagrams](#5-data-flow-diagrams)
6. [File Structure](#6-file-structure)
7. [Package Design](#7-package-design)
8. [Migration from Current State](#8-migration-from-current-state)
9. [Testing Strategy](#9-testing-strategy)
10. [Effort Summary](#10-effort-summary)

---

## 1. Architecture Overview

### 1.1 Design Philosophy

DzipAgent evaluation and testing follows three principles:

1. **Determinism by default.** Every test can run without network calls. LLM recorder captures interactions; mock models provide scripted responses. Live LLM calls are opt-in only.
2. **Composition over configuration.** Scorers, datasets, and runners are small composable units. A composite scorer is just a weighted bag of other scorers. An eval run is just a dataset mapped through a scorer set.
3. **CI/CD as a first-class target.** Every eval produces a machine-readable report with exit codes. Regression detection compares against persisted baselines. GitHub Actions templates ship with the package.

### 1.2 Architecture Diagram

```
                          +---------------------------+
                          |     CI/CD Pipeline        |
                          |  (GitHub Actions / CLI)   |
                          +---------------------------+
                                     |
                                     | run evals, compare baselines
                                     v
+------------------+     +---------------------------+     +-------------------+
|  @dzipagent/    |     |    @dzipagent/evals      |     | @dzipagent/      |
|  testing         |     |                           |     | codegen           |
|                  |     |  +---------------------+  |     |                   |
|  MockChatModel   |---->|  | EvalRunner          |  |     |  QualityScorer    |
|  LLMRecorder     |     |  |  - evaluate()       |  |     |  (code-specific)  |
|  TestDzipAgent  |     |  |  - evaluateBatch()  |  |     +-------------------+
|  TestMCPServer   |     |  |  - regressionCheck()|  |              |
|  TestA2AServer   |     |  +---------------------+  |              | bridge
|  Assertion       |     |           |                |              v
|  Helpers         |     |  +---------------------+  |     +-------------------+
|                  |     |  | Scorers             |  |     | CodeQualityScorer |
+------------------+     |  |  - LLMJudgeScorer   |  |     | (adapts codegen   |
                          |  |  - RegexScorer      |  |<----| QualityScorer to  |
                          |  |  - JSONSchemaScorer |  |     | eval Scorer iface)|
                          |  |  - KeywordScorer    |  |     +-------------------+
                          |  |  - LatencyScorer    |  |
                          |  |  - CostScorer       |  |
                          |  |  - CompositeScorer  |  |
                          |  +---------------------+  |
                          |           |                |
                          |  +---------------------+  |
                          |  | EvalDataset         |  |
                          |  |  - load(JSON/CSV)   |  |
                          |  |  - filter(tags)     |  |
                          |  |  - version()        |  |
                          |  +---------------------+  |
                          |           |                |
                          |  +---------------------+  |
                          |  | EvalReporter        |  |
                          |  |  - toJSON()         |  |
                          |  |  - toMarkdown()     |  |
                          |  |  - toCIAnnotations()|  |
                          |  +---------------------+  |
                          +---------------------------+
```

### 1.3 Dependency Graph

```
@langchain/core (peer)
       |
       v
@dzipagent/core -----> @dzipagent/evals
       |                       |
       v                       v
@dzipagent/agent        @dzipagent/testing
       |                       |
       v                       v
  [Consumer tests]       [Consumer tests]
```

Rules:
- `@dzipagent/evals` depends on `@dzipagent/core` (for event types, store interfaces) and `@langchain/core` (peer, for BaseChatModel in LLM judge).
- `@dzipagent/testing` depends on `@dzipagent/core` (for event bus, model registry, stores) and `@langchain/core` (peer, for BaseChatModel, messages).
- Neither package depends on `@dzipagent/agent` or `@dzipagent/codegen`. Those packages depend on testing/evals as dev dependencies.
- The `CodeQualityScorer` bridge (adapting codegen's `QualityScorer` to the evals `Scorer` interface) lives in `@dzipagent/codegen` since it depends on codegen types.

### 1.4 LLM Recorder/Replay System

The recorder intercepts LLM calls at the `BaseChatModel` boundary, which is the lowest level that captures all tool-calling behavior.

```
Test code
    |
    v
 LLMRecorder.wrap(realModel) --> returns a wrapped BaseChatModel
    |
    +--- mode: 'record' ---> call real model, save {hash, request, response} to JSONL cassette
    |
    +--- mode: 'replay' ---> hash request, look up in cassette, return saved response
    |
    +--- mode: 'passthrough' ---> call real model, no saving
```

Cassette files are JSONL (one fixture per line) stored in `__fixtures__/llm/`. The hash function defaults to SHA-256 of message content but is pluggable for fuzzy matching.

### 1.5 CI/CD Integration Model

```
PR opened
    |
    v
GitHub Actions: forge-evals.yml
    |
    +---> Install deps, build packages
    |
    +---> Run unit tests (vitest, mock models, no network)
    |
    +---> Run eval suite:
    |       - Load dataset from evals/datasets/*.jsonl
    |       - Run EvalRunner with configured scorers
    |       - Compare against baselines in evals/baselines/*.json
    |       - Generate EvalReport
    |
    +---> Post results:
    |       - PR comment with markdown table
    |       - CI annotations for regressions
    |       - Exit code 1 if any scorer below threshold
    |
    +---> (Optional) Upload report as artifact
```

---

## 2. Current State Analysis

### 2.1 What Exists

| Component | Package | Status | Gaps |
|-----------|---------|--------|------|
| `Scorer` interface | `@dzipagent/evals` | Implemented | Missing generic type params, no `ScorerConfig`, no `description` field |
| `EvalInput` / `EvalResult` | `@dzipagent/evals` | Implemented | No `tags`, no `latencyMs`, no `costCents` tracking |
| `createLLMJudge()` | `@dzipagent/evals` | Implemented | Single-criteria only, no multi-criteria, no rubric scales, no cost tracking |
| `createDeterministicScorer()` | `@dzipagent/evals` | Implemented | Missing `JSONSchemaScorer`, `KeywordScorer` (required + forbidden), `LatencyScorer`, `CostScorer` |
| `createCompositeScorer()` | `@dzipagent/evals` | Implemented | Works, no changes needed |
| `EvalRunner` | `@dzipagent/evals` | Implemented | No concurrency control, no progress events, no CI exit mode, sequential batch only |
| `MockChatModel` | `@dzipagent/testing` | Implemented | No error simulation, no pattern-matched responses, no latency simulation |
| `LLMRecorder` | `@dzipagent/testing` | Implemented | Uses `require()` (breaks ESM), no JSONL multi-fixture cassettes, no fuzzy matching, no recording filters |
| Test helpers | `@dzipagent/testing` | Implemented | Missing `TestDzipAgent`, `TestMCPServer`, `TestA2AServer`, scenario runner, assertion helpers |
| `QualityScorer` | `@dzipagent/codegen` | Implemented | Code-specific only, not wired to eval `Scorer` interface |
| Datasets | None | Not started | No dataset loading, versioning, or tag filtering |
| Benchmarks | None | Not started | No standard benchmark suites |
| CI/CD templates | None | Not started | No GitHub Actions workflow |
| Eval persistence | `@dzipagent/evals` | Interface only | `EvalResultStore` exists but no implementations |

### 2.2 Quality of Existing Code

The existing implementations are functional and well-tested (scorer tests pass, eval-runner tests pass). The main gaps are:

1. **Missing features** rather than bugs -- no datasets, no benchmarks, no CI integration.
2. **ESM violation** in `LLMRecorder.listFixtures()` which uses `require('node:fs')`.
3. **Type narrowing** -- `Scorer` interface lacks generic params for typed input/output.
4. **No integration between codegen QualityScorer and evals Scorer** -- they are parallel systems.

---

## 3. Feature Specifications

### F1: Scorer Interface (P1, 4h)

**Owner:** `@dzipagent/evals`
**File:** `src/types.ts`

The current `Scorer` interface is functional but lacks generics, configuration metadata, and structured scoring details. This feature enhances the type contracts while maintaining backward compatibility.

```typescript
// @dzipagent/evals/src/types.ts

/**
 * A single score value with optional metadata.
 *
 * All scores are normalized to 0-1. The `label` field provides a human-readable
 * classification (e.g., "excellent", "poor"). The `reasoning` field captures
 * why this score was assigned -- populated by LLM judges, empty for deterministic scorers.
 *
 * @example
 * ```ts
 * const score: Score = {
 *   value: 0.85,
 *   label: 'good',
 *   reasoning: 'Output covers all key points but misses edge case handling.',
 *   metadata: { tokensUsed: 150 },
 * }
 * ```
 */
export interface Score {
  /** Normalized score between 0 and 1, inclusive */
  value: number
  /** Human-readable classification label */
  label?: string
  /** Explanation of why this score was assigned */
  reasoning?: string
  /** Scorer-specific metadata (token counts, matched patterns, etc.) */
  metadata?: Record<string, unknown>
}

/**
 * Configuration for a scorer, including identity and pass/fail threshold.
 *
 * Scorers carry their config so eval reports can include full provenance:
 * which scorer, what threshold, what version produced each score.
 */
export interface ScorerConfig {
  /** Unique scorer identifier (used in reports and baselines) */
  id: string
  /** Human-readable name */
  name: string
  /** What this scorer measures */
  description: string
  /** Score type discriminator */
  type: 'llm' | 'deterministic' | 'composite' | 'statistical'
  /** Minimum score to pass (default: 0.7) */
  threshold: number
  /** Scorer version (for baseline compatibility tracking) */
  version?: string
}

/**
 * Result of a single scorer evaluation, extending Score with pass/fail status.
 */
export interface ScorerResult {
  /** The scorer that produced this result */
  scorerId: string
  /** The scores produced (single scorers produce one; multi-criteria produce many) */
  scores: Score[]
  /** Aggregate score across all dimensions (0-1) */
  aggregateScore: number
  /** Whether aggregateScore >= threshold */
  passed: boolean
  /** Duration of the scoring evaluation in milliseconds */
  durationMs: number
  /** Cost in cents if LLM calls were made */
  costCents?: number
}

/**
 * Generic scorer interface.
 *
 * TInput is the type of data being scored. The default is `EvalInput` for
 * agent response evaluation, but scorers can be parameterized for other
 * domains (e.g., code quality scoring where TInput is a VFS record).
 *
 * @example
 * ```ts
 * // Standard agent response scorer
 * const faithfulness: Scorer<EvalInput> = createLLMJudge({ ... })
 *
 * // Custom domain scorer
 * const codeQuality: Scorer<{ files: Record<string, string> }> = { ... }
 * ```
 */
export interface Scorer<TInput = EvalInput> {
  /** Scorer configuration and identity */
  readonly config: ScorerConfig
  /** Evaluate an input and produce a result */
  evaluate(input: TInput): Promise<ScorerResult>
}

/**
 * Input to an evaluation scorer for agent response evaluation.
 *
 * This is the standard input type for most scorers. Custom scorers can
 * use different input types via the Scorer<TInput> generic.
 */
export interface EvalInput {
  /** The prompt/task given to the agent */
  input: string
  /** The agent's response */
  output: string
  /** Expected/golden answer (optional, for reference-based scoring) */
  reference?: string
  /** Additional context provided to the agent */
  context?: string
  /** Tags for filtering and categorization */
  tags?: string[]
  /** Time taken to produce the output, in milliseconds */
  latencyMs?: number
  /** Cost of producing the output, in cents */
  costCents?: number
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>
}

/**
 * Backward-compatible alias for consumers using the v0.1 EvalResult type.
 * @deprecated Use ScorerResult instead.
 */
export interface EvalResult {
  scorerId: string
  score: number
  pass: boolean
  reasoning?: string
  metadata?: Record<string, unknown>
}

/**
 * Stored evaluation record for persistence.
 */
export interface EvalRecord {
  /** Unique evaluation run ID */
  id: string
  /** Input that was evaluated */
  input: EvalInput
  /** Results from all scorers */
  results: ScorerResult[]
  /** When this evaluation was performed */
  timestamp: Date
  /** Which eval run this belongs to */
  runId?: string
}

/**
 * Store interface for persisting evaluation results.
 * Implementations: InMemoryEvalStore (built-in), PostgresEvalStore (@dzipagent/server).
 */
export interface EvalResultStore {
  save(record: EvalRecord): Promise<void>
  get(id: string): Promise<EvalRecord | null>
  list(filter?: EvalResultFilter): Promise<EvalRecord[]>
  /** Get the most recent run's results for baseline comparison */
  getBaseline(runId: string): Promise<Map<string, number>>
  /** Save a baseline snapshot */
  saveBaseline(runId: string, averages: Map<string, number>): Promise<void>
}

export interface EvalResultFilter {
  scorerId?: string
  runId?: string
  tags?: string[]
  since?: Date
  limit?: number
  offset?: number
}
```

**Backward compatibility:** The existing `Scorer` type (with `id`, `type`, `threshold`, `evaluate()`) remains exported as a deprecated alias. A `toLegacyScorer()` adapter converts the new `Scorer<EvalInput>` to the old shape. Existing tests continue to compile unchanged.

---

### F2: LLM-as-Judge Scorer (P1, 8h)

**Owner:** `@dzipagent/evals`
**Files:** `src/scorers/llm-judge.ts`, `src/scorers/criteria.ts`

Enhances the existing `createLLMJudge()` with multi-criteria evaluation, rubric scales, cost tracking, and structured output parsing.

```typescript
// @dzipagent/evals/src/scorers/llm-judge.ts

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Scorer, ScorerConfig, ScorerResult, EvalInput, Score } from '../types.js'

/**
 * A single evaluation criterion for multi-criteria LLM judging.
 */
export interface JudgeCriterion {
  /** Unique name for this criterion (e.g., 'faithfulness', 'coherence') */
  name: string
  /** Natural language description of what to evaluate */
  description: string
  /** Weight for aggregate scoring (default: 1) */
  weight?: number
}

/**
 * Rubric definition for structured scoring.
 * Maps score ranges to descriptions for consistent LLM evaluation.
 *
 * @example
 * ```ts
 * const rubric: JudgeRubric = {
 *   scale: 5,
 *   levels: [
 *     { score: 1, label: 'poor', description: 'Completely incorrect or irrelevant' },
 *     { score: 2, label: 'below average', description: 'Partially correct but major gaps' },
 *     { score: 3, label: 'average', description: 'Mostly correct with minor issues' },
 *     { score: 4, label: 'good', description: 'Correct and well-structured' },
 *     { score: 5, label: 'excellent', description: 'Perfect, comprehensive response' },
 *   ],
 * }
 * ```
 */
export interface JudgeRubric {
  /** Maximum score on the rubric scale (e.g., 5 or 10) */
  scale: number
  /** Description of each score level */
  levels: Array<{
    score: number
    label: string
    description: string
  }>
}

/**
 * Configuration for creating an LLM judge scorer.
 */
export interface LLMJudgeConfig {
  /** Unique scorer ID */
  id: string
  /** Human-readable name (default: id) */
  name?: string
  /** Description of what this judge evaluates */
  description?: string
  /** LLM model to use as judge (recommended: fast/cheap model like claude-haiku) */
  model: BaseChatModel
  /**
   * Evaluation criteria. Can be:
   * - A single string (single-criterion mode)
   * - An array of JudgeCriterion (multi-criteria mode)
   */
  criteria: string | JudgeCriterion[]
  /** Rubric for structured scoring (optional, defaults to 10-point scale) */
  rubric?: JudgeRubric
  /** Pass threshold (default: 0.7) */
  threshold?: number
  /**
   * Custom prompt template. Available variables:
   * - {{criteria}} -- the evaluation criteria text
   * - {{rubric}} -- the rubric description (if provided)
   * - {{input}} -- the agent's input/task
   * - {{output}} -- the agent's response
   * - {{reference}} -- the expected answer (if provided)
   * - {{context}} -- additional context (if provided)
   */
  promptTemplate?: string
  /** Maximum retries for judge LLM calls (default: 2) */
  maxRetries?: number
  /** Whether to track cost of judge calls (default: true) */
  trackCost?: boolean
}

/**
 * Parsed response from the judge LLM.
 * The judge is prompted to return this JSON shape.
 */
interface JudgeResponse {
  scores: Array<{
    criterion: string
    score: number
    reasoning: string
  }>
}

/**
 * Default prompt template for single-criterion evaluation.
 */
const DEFAULT_SINGLE_CRITERION_TEMPLATE = `You are an expert evaluator. Evaluate the following output against the given criteria.

**Criteria:** {{criteria}}
{{rubric}}

**Task/Input:** {{input}}
**Agent Output:** {{output}}
{{reference}}
{{context}}

Rate on a scale of 0-{{scale}} and explain your reasoning.
Respond as JSON: { "scores": [{ "criterion": "{{criterionName}}", "score": <number>, "reasoning": "<string>" }] }`

/**
 * Default prompt template for multi-criteria evaluation.
 */
const DEFAULT_MULTI_CRITERIA_TEMPLATE = `You are an expert evaluator. Evaluate the following output against EACH criterion independently.

**Criteria:**
{{criteria}}
{{rubric}}

**Task/Input:** {{input}}
**Agent Output:** {{output}}
{{reference}}
{{context}}

For EACH criterion, rate on a scale of 0-{{scale}} and explain your reasoning.
Respond as JSON: { "scores": [{ "criterion": "<name>", "score": <number>, "reasoning": "<string>" }, ...] }`

/**
 * Create an LLM-as-judge scorer.
 *
 * Supports single-criterion and multi-criteria evaluation. Each criterion
 * produces a separate Score in the ScorerResult. The aggregate score is a
 * weighted average across all criteria.
 *
 * @example Single-criterion
 * ```ts
 * const faithfulness = createLLMJudge({
 *   id: 'faithfulness',
 *   model: new ChatAnthropic({ model: 'claude-haiku-4-5' }),
 *   criteria: 'Is the output faithful to the provided context? Does it avoid hallucination?',
 *   threshold: 0.8,
 * })
 * ```
 *
 * @example Multi-criteria
 * ```ts
 * const quality = createLLMJudge({
 *   id: 'response-quality',
 *   model: new ChatAnthropic({ model: 'claude-haiku-4-5' }),
 *   criteria: [
 *     { name: 'faithfulness', description: 'No hallucination, grounded in context', weight: 3 },
 *     { name: 'relevance', description: 'Directly addresses the question', weight: 2 },
 *     { name: 'coherence', description: 'Well-structured and logical', weight: 1 },
 *     { name: 'safety', description: 'No harmful or biased content', weight: 2 },
 *   ],
 * })
 * ```
 */
export function createLLMJudge(config: LLMJudgeConfig): Scorer<EvalInput> {
  const threshold = config.threshold ?? 0.7
  const rubric = config.rubric ?? { scale: 10, levels: [] }
  const maxRetries = config.maxRetries ?? 2
  const trackCost = config.trackCost ?? true

  const criteria: JudgeCriterion[] = typeof config.criteria === 'string'
    ? [{ name: config.id, description: config.criteria, weight: 1 }]
    : config.criteria

  const scorerConfig: ScorerConfig = {
    id: config.id,
    name: config.name ?? config.id,
    description: config.description ?? `LLM judge: ${criteria.map(c => c.name).join(', ')}`,
    type: 'llm',
    threshold,
  }

  return {
    config: scorerConfig,

    async evaluate(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now()
      let costCents = 0

      // Build the prompt
      const prompt = buildJudgePrompt(config, criteria, rubric, input)

      // Call the judge with retries
      let judgeResponse: JudgeResponse | null = null
      let lastError: string | null = null

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await config.model.invoke([
            { role: 'user', content: prompt } as unknown as import('@langchain/core/messages').BaseMessage,
          ])

          const text = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content)

          // Track cost if usage metadata available
          if (trackCost && response.usage_metadata) {
            const usage = response.usage_metadata
            // Rough cost estimation -- caller can override via metadata
            costCents += (usage.input_tokens * 0.00025 + usage.output_tokens * 0.00125) / 10
          }

          judgeResponse = parseJudgeResponse(text, criteria)
          if (judgeResponse) break
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }

      const durationMs = Date.now() - startTime

      // If all retries failed, return zero scores
      if (!judgeResponse) {
        return {
          scorerId: config.id,
          scores: criteria.map(c => ({
            value: 0,
            label: 'error',
            reasoning: lastError ?? 'Failed to parse judge response',
          })),
          aggregateScore: 0,
          passed: false,
          durationMs,
          costCents: trackCost ? costCents : undefined,
        }
      }

      // Map judge scores to Score objects
      const scores: Score[] = judgeResponse.scores.map(s => ({
        value: Math.max(0, Math.min(1, s.score / rubric.scale)),
        label: getLabelForScore(s.score, rubric),
        reasoning: s.reasoning,
        metadata: { criterion: s.criterion, rawScore: s.score, scale: rubric.scale },
      }))

      // Compute weighted aggregate
      const totalWeight = criteria.reduce((sum, c) => sum + (c.weight ?? 1), 0)
      const aggregateScore = totalWeight > 0
        ? scores.reduce((sum, score, i) => sum + score.value * (criteria[i]?.weight ?? 1), 0) / totalWeight
        : 0

      return {
        scorerId: config.id,
        scores,
        aggregateScore,
        passed: aggregateScore >= threshold,
        durationMs,
        costCents: trackCost ? costCents : undefined,
      }
    },
  }
}

/** Build the evaluation prompt from config and input */
function buildJudgePrompt(
  config: LLMJudgeConfig,
  criteria: JudgeCriterion[],
  rubric: JudgeRubric,
  input: EvalInput,
): string {
  // Implementation: template variable substitution
  // Selects single vs multi-criteria template based on criteria count
  // Replaces {{criteria}}, {{rubric}}, {{input}}, {{output}}, {{reference}}, {{context}}, {{scale}}
  // This is a specification -- implementation follows the template strings above
  throw new Error('Implementation placeholder')
}

/** Parse the judge's JSON response, handling markdown code blocks */
function parseJudgeResponse(text: string, criteria: JudgeCriterion[]): JudgeResponse | null {
  // Implementation: extract JSON from response, validate structure
  // Handle: bare JSON, ```json...``` blocks, partial matches
  // Validate: each criterion has a score entry
  throw new Error('Implementation placeholder')
}

/** Map a raw score to its rubric label */
function getLabelForScore(score: number, rubric: JudgeRubric): string | undefined {
  if (rubric.levels.length === 0) return undefined
  // Find the closest rubric level
  const sorted = [...rubric.levels].sort((a, b) =>
    Math.abs(a.score - score) - Math.abs(b.score - score)
  )
  return sorted[0]?.label
}
```

**Pre-built criteria sets:**

```typescript
// @dzipagent/evals/src/scorers/criteria.ts

import type { JudgeCriterion, JudgeRubric } from './llm-judge.js'

/**
 * Standard evaluation criteria for agent response quality.
 * Based on the RAGAS framework adapted for agentic systems.
 */
export const STANDARD_CRITERIA: Record<string, JudgeCriterion> = {
  faithfulness: {
    name: 'faithfulness',
    description: 'The output is grounded in the provided context and input. No hallucinated facts or unsupported claims.',
    weight: 3,
  },
  relevance: {
    name: 'relevance',
    description: 'The output directly addresses the input question or task. No tangential or off-topic content.',
    weight: 2,
  },
  coherence: {
    name: 'coherence',
    description: 'The output is well-structured, logically organized, and easy to follow.',
    weight: 1,
  },
  completeness: {
    name: 'completeness',
    description: 'The output covers all aspects of the input task. No missing requirements or incomplete answers.',
    weight: 2,
  },
  safety: {
    name: 'safety',
    description: 'The output contains no harmful, biased, or inappropriate content.',
    weight: 3,
  },
  helpfulness: {
    name: 'helpfulness',
    description: 'The output is genuinely useful and actionable for the user.',
    weight: 2,
  },
}

/**
 * Code generation specific criteria.
 */
export const CODE_CRITERIA: Record<string, JudgeCriterion> = {
  correctness: {
    name: 'correctness',
    description: 'The code is syntactically valid and would compile/run without errors.',
    weight: 4,
  },
  completeness: {
    name: 'completeness',
    description: 'The code implements all requested functionality with no missing pieces.',
    weight: 3,
  },
  style: {
    name: 'style',
    description: 'The code follows language conventions, is well-formatted, and uses meaningful names.',
    weight: 1,
  },
  typesSafety: {
    name: 'type-safety',
    description: 'The code uses proper TypeScript types, no `any`, no type assertions without justification.',
    weight: 2,
  },
  errorHandling: {
    name: 'error-handling',
    description: 'The code handles edge cases and errors appropriately.',
    weight: 2,
  },
}

/**
 * Standard 5-point rubric for structured evaluation.
 */
export const FIVE_POINT_RUBRIC: JudgeRubric = {
  scale: 5,
  levels: [
    { score: 1, label: 'poor', description: 'Completely incorrect, irrelevant, or harmful' },
    { score: 2, label: 'below-average', description: 'Partially correct but has major gaps or errors' },
    { score: 3, label: 'average', description: 'Mostly correct with some minor issues' },
    { score: 4, label: 'good', description: 'Correct, complete, and well-structured' },
    { score: 5, label: 'excellent', description: 'Outstanding -- exceeds expectations in all criteria' },
  ],
}

/**
 * Standard 10-point rubric (default for LLM judge).
 */
export const TEN_POINT_RUBRIC: JudgeRubric = {
  scale: 10,
  levels: [
    { score: 0, label: 'invalid', description: 'No meaningful output' },
    { score: 1, label: 'terrible', description: 'Completely wrong' },
    { score: 2, label: 'very-poor', description: 'Mostly wrong with a small kernel of relevance' },
    { score: 3, label: 'poor', description: 'Significant errors, partially relevant' },
    { score: 4, label: 'below-average', description: 'Some correct elements but misses the point' },
    { score: 5, label: 'average', description: 'Adequate but unremarkable' },
    { score: 6, label: 'above-average', description: 'Mostly correct with minor issues' },
    { score: 7, label: 'good', description: 'Correct and well-structured' },
    { score: 8, label: 'very-good', description: 'Thorough and insightful' },
    { score: 9, label: 'excellent', description: 'Near-perfect execution' },
    { score: 10, label: 'outstanding', description: 'Flawless, comprehensive, exceeds all expectations' },
  ],
}

/**
 * CLEAR framework criteria (Cost, Latency, Efficiency, Assurance, Reliability).
 * These are measured by deterministic scorers, not LLM judges, but defined
 * here for reference and composite scoring.
 */
export const CLEAR_CRITERIA: Record<string, JudgeCriterion> = {
  cost: {
    name: 'cost',
    description: 'Total token cost stays within budget',
    weight: 2,
  },
  latency: {
    name: 'latency',
    description: 'Response time meets SLA requirements',
    weight: 2,
  },
  efficiency: {
    name: 'efficiency',
    description: 'Minimal unnecessary LLM calls and tool invocations',
    weight: 1,
  },
  assurance: {
    name: 'assurance',
    description: 'Output meets safety and correctness guardrails',
    weight: 3,
  },
  reliability: {
    name: 'reliability',
    description: 'Consistent results across repeated runs',
    weight: 2,
  },
}
```

---

### F3: Deterministic Scorers (P1, 4h)

**Owner:** `@dzipagent/evals`
**File:** `src/scorers/deterministic.ts`

Extends the existing deterministic scorers with new types: `JSONSchemaScorer`, `KeywordScorer` (with required and forbidden lists), `LatencyScorer`, and `CostScorer`. All conform to the enhanced `Scorer<EvalInput>` interface.

```typescript
// @dzipagent/evals/src/scorers/deterministic.ts (additions)

import type { Scorer, ScorerConfig, ScorerResult, EvalInput, Score } from '../types.js'

/**
 * Helper to create a deterministic scorer from a check function.
 * Updated to conform to the new Scorer<EvalInput> interface while
 * maintaining backward compatibility with the existing createDeterministicScorer.
 */
export interface DeterministicScorerConfig {
  /** Unique scorer ID */
  id: string
  /** Human-readable name (defaults to id) */
  name?: string
  /** What this scorer checks */
  description?: string
  /** Scoring function: returns 0-1 */
  check: (input: EvalInput) => number | { value: number; reasoning?: string }
  /** Pass threshold (default: 0.7) */
  threshold?: number
}

export function createDeterministicScorer(config: DeterministicScorerConfig): Scorer<EvalInput> {
  const threshold = config.threshold ?? 0.7

  const scorerConfig: ScorerConfig = {
    id: config.id,
    name: config.name ?? config.id,
    description: config.description ?? `Deterministic scorer: ${config.id}`,
    type: 'deterministic',
    threshold,
  }

  return {
    config: scorerConfig,

    async evaluate(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now()
      const raw = config.check(input)
      const value = typeof raw === 'number' ? raw : raw.value
      const reasoning = typeof raw === 'number' ? undefined : raw.reasoning
      const clamped = Math.max(0, Math.min(1, value))
      const durationMs = Date.now() - startTime

      return {
        scorerId: config.id,
        scores: [{ value: clamped, reasoning }],
        aggregateScore: clamped,
        passed: clamped >= threshold,
        durationMs,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// New deterministic scorer types
// ---------------------------------------------------------------------------

/**
 * Validate output against a JSON Schema.
 *
 * Uses a lightweight schema validator (no external dependency -- checks
 * type, required fields, and patterns). For full JSON Schema validation,
 * pass a custom validate function.
 *
 * @example
 * ```ts
 * const apiResponse = createJSONSchemaScorer('api-response', {
 *   type: 'object',
 *   required: ['status', 'data'],
 *   properties: {
 *     status: { type: 'string', enum: ['success', 'error'] },
 *     data: { type: 'object' },
 *   },
 * })
 * ```
 */
export interface JSONSchemaDefinition {
  type: string
  required?: string[]
  properties?: Record<string, { type: string; enum?: unknown[] }>
  items?: JSONSchemaDefinition
}

export function createJSONSchemaScorer(
  id: string,
  schema: JSONSchemaDefinition,
  options?: {
    /** Custom validation function for full JSON Schema support */
    validate?: (data: unknown) => { valid: boolean; errors: string[] }
    threshold?: number
  },
): Scorer<EvalInput> {
  return createDeterministicScorer({
    id,
    name: `JSON Schema: ${id}`,
    description: `Validates output conforms to JSON schema`,
    threshold: options?.threshold ?? 1.0, // Schema validation is binary by default
    check: (input) => {
      try {
        const parsed = JSON.parse(input.output)
        if (options?.validate) {
          const result = options.validate(parsed)
          return { value: result.valid ? 1 : 0, reasoning: result.errors.join('; ') }
        }
        return { value: validateBasicSchema(parsed, schema) ? 1 : 0 }
      } catch {
        return { value: 0, reasoning: 'Output is not valid JSON' }
      }
    },
  })
}

/**
 * Score based on required and forbidden keywords.
 *
 * The score is computed as: (required_found / required_total) * (1 - forbidden_found / forbidden_total)
 * If no required keywords, only forbidden keywords are checked (and vice versa).
 *
 * @example
 * ```ts
 * const keywords = createKeywordScorer('code-keywords', {
 *   required: ['interface', 'export', 'async'],
 *   forbidden: ['any', 'console.log', '@ts-ignore'],
 * })
 * ```
 */
export function createKeywordScorer(
  id: string,
  config: {
    required?: string[]
    forbidden?: string[]
    caseSensitive?: boolean
    threshold?: number
  },
): Scorer<EvalInput> {
  const required = config.required ?? []
  const forbidden = config.forbidden ?? []

  return createDeterministicScorer({
    id,
    name: `Keywords: ${id}`,
    description: `Checks for required (${required.length}) and forbidden (${forbidden.length}) keywords`,
    threshold: config.threshold,
    check: (input) => {
      const text = config.caseSensitive ? input.output : input.output.toLowerCase()

      let requiredScore = 1
      if (required.length > 0) {
        const found = required.filter(k =>
          text.includes(config.caseSensitive ? k : k.toLowerCase()),
        )
        requiredScore = found.length / required.length
      }

      let forbiddenScore = 1
      if (forbidden.length > 0) {
        const found = forbidden.filter(k =>
          text.includes(config.caseSensitive ? k : k.toLowerCase()),
        )
        forbiddenScore = 1 - (found.length / forbidden.length)
      }

      const value = requiredScore * forbiddenScore
      const reasoning = [
        required.length > 0 ? `Required: ${Math.round(requiredScore * 100)}% found` : null,
        forbidden.length > 0 ? `Forbidden: ${Math.round((1 - forbiddenScore) * 100)}% found` : null,
      ].filter(Boolean).join(', ')

      return { value, reasoning }
    },
  })
}

/**
 * Score based on response latency.
 *
 * Uses the `latencyMs` field from EvalInput. Scores 1.0 if latency
 * is at or below the target, degrades linearly to 0 at maxLatency.
 *
 * @example
 * ```ts
 * const fast = createLatencyScorer('response-time', {
 *   targetMs: 2000,   // ideal: under 2s
 *   maxMs: 10000,     // unacceptable: over 10s
 * })
 * ```
 */
export function createLatencyScorer(
  id: string,
  config: {
    /** Target latency in ms (score = 1.0 at or below this) */
    targetMs: number
    /** Maximum acceptable latency in ms (score = 0 at or above this) */
    maxMs: number
    threshold?: number
  },
): Scorer<EvalInput> {
  return createDeterministicScorer({
    id,
    name: `Latency: ${id}`,
    description: `Target ${config.targetMs}ms, max ${config.maxMs}ms`,
    threshold: config.threshold,
    check: (input) => {
      if (input.latencyMs === undefined) {
        return { value: 0, reasoning: 'No latencyMs provided in input' }
      }
      if (input.latencyMs <= config.targetMs) return { value: 1, reasoning: `${input.latencyMs}ms <= target ${config.targetMs}ms` }
      if (input.latencyMs >= config.maxMs) return { value: 0, reasoning: `${input.latencyMs}ms >= max ${config.maxMs}ms` }

      const value = 1 - (input.latencyMs - config.targetMs) / (config.maxMs - config.targetMs)
      return { value, reasoning: `${input.latencyMs}ms (between target and max)` }
    },
  })
}

/**
 * Score based on token/cost budgets.
 *
 * Uses the `costCents` field from EvalInput. Scores 1.0 if cost is at
 * or below the target, degrades linearly to 0 at maxCost.
 *
 * @example
 * ```ts
 * const budget = createCostScorer('cost-budget', {
 *   targetCents: 5,   // ideal: under 5 cents
 *   maxCents: 25,     // unacceptable: over 25 cents
 * })
 * ```
 */
export function createCostScorer(
  id: string,
  config: {
    targetCents: number
    maxCents: number
    threshold?: number
  },
): Scorer<EvalInput> {
  return createDeterministicScorer({
    id,
    name: `Cost: ${id}`,
    description: `Target ${config.targetCents}c, max ${config.maxCents}c`,
    threshold: config.threshold,
    check: (input) => {
      if (input.costCents === undefined) {
        return { value: 0, reasoning: 'No costCents provided in input' }
      }
      if (input.costCents <= config.targetCents) return { value: 1 }
      if (input.costCents >= config.maxCents) return { value: 0 }

      const value = 1 - (input.costCents - config.targetCents) / (config.maxCents - config.targetCents)
      return { value, reasoning: `${input.costCents}c (between target and max)` }
    },
  })
}

/**
 * Basic JSON Schema validation (no external dependency).
 * Checks type, required fields, and enum values.
 */
function validateBasicSchema(data: unknown, schema: JSONSchemaDefinition): boolean {
  // Implementation: recursive schema check
  // type check, required field check, enum check
  throw new Error('Implementation placeholder')
}

// ---------------------------------------------------------------------------
// Existing scorers updated for new interface (backward compatible)
// containsScorer, jsonValidScorer, lengthScorer, regexScorer, exactMatchScorer
// remain exported with their current signatures but internally produce ScorerResult
// ---------------------------------------------------------------------------
```

---

### F4: Eval Dataset (P1, 4h)

**Owner:** `@dzipagent/evals`
**Files:** `src/dataset/eval-dataset.ts`, `src/dataset/loaders.ts`

Introduces a structured dataset type for organizing evaluation inputs, with loaders for JSON, JSONL, and CSV formats, plus tag-based filtering and versioning.

```typescript
// @dzipagent/evals/src/dataset/eval-dataset.ts

import type { EvalInput } from '../types.js'

/**
 * A single entry in an evaluation dataset.
 * Extends EvalInput with an explicit ID for tracking across runs.
 */
export interface EvalEntry extends EvalInput {
  /** Unique identifier for this entry within the dataset */
  id: string
}

/**
 * Metadata for an evaluation dataset.
 */
export interface DatasetMetadata {
  /** Unique dataset identifier */
  name: string
  /** Human-readable description */
  description?: string
  /** Semantic version of this dataset */
  version: string
  /** When this dataset was created */
  createdAt: string
  /** Who created this dataset */
  author?: string
  /** Tags for categorizing the dataset */
  tags?: string[]
  /** Number of entries (computed) */
  entryCount?: number
}

/**
 * An evaluation dataset containing labeled examples for testing agents.
 *
 * Datasets are immutable once loaded. Use `filter()` and `sample()` to
 * create subsets for targeted evaluation.
 *
 * @example
 * ```ts
 * // Load from JSONL file
 * const dataset = await EvalDataset.fromJSONL('evals/datasets/qa-v1.jsonl')
 *
 * // Filter by tags
 * const hardCases = dataset.filter({ tags: ['hard', 'edge-case'] })
 *
 * // Random sample
 * const sample = dataset.sample(50)
 *
 * // Use with EvalRunner
 * const runner = new EvalRunner(scorers)
 * const report = await runner.evaluateDataset(dataset)
 * ```
 */
export class EvalDataset {
  readonly metadata: DatasetMetadata
  readonly entries: readonly EvalEntry[]

  constructor(metadata: DatasetMetadata, entries: EvalEntry[]) {
    this.metadata = { ...metadata, entryCount: entries.length }
    this.entries = Object.freeze([...entries])
  }

  /** Number of entries in this dataset */
  get size(): number {
    return this.entries.length
  }

  /**
   * Filter entries by tags (AND logic: entry must have ALL specified tags).
   * Returns a new EvalDataset with matching entries.
   */
  filter(criteria: { tags?: string[]; ids?: string[] }): EvalDataset {
    let filtered = [...this.entries]

    if (criteria.tags && criteria.tags.length > 0) {
      filtered = filtered.filter(e =>
        criteria.tags!.every(tag => e.tags?.includes(tag)),
      )
    }

    if (criteria.ids && criteria.ids.length > 0) {
      const idSet = new Set(criteria.ids)
      filtered = filtered.filter(e => idSet.has(e.id))
    }

    return new EvalDataset(
      { ...this.metadata, name: `${this.metadata.name}:filtered` },
      filtered,
    )
  }

  /**
   * Random sample of entries. Uses Fisher-Yates shuffle.
   * Returns a new EvalDataset with sampled entries.
   */
  sample(count: number, seed?: number): EvalDataset {
    if (count >= this.entries.length) return this
    const shuffled = [...this.entries]
    // Seeded shuffle for reproducibility
    const rng = seed !== undefined ? seededRandom(seed) : Math.random
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    return new EvalDataset(
      { ...this.metadata, name: `${this.metadata.name}:sample(${count})` },
      shuffled.slice(0, count),
    )
  }

  /** Get all unique tags across all entries */
  allTags(): string[] {
    const tags = new Set<string>()
    for (const entry of this.entries) {
      if (entry.tags) entry.tags.forEach(t => tags.add(t))
    }
    return [...tags].sort()
  }

  /** Convert to EvalInput array (strips IDs) for backward compatibility */
  toInputs(): EvalInput[] {
    return this.entries.map(({ id: _id, ...rest }) => rest)
  }

  // --- Static factory methods ---

  /** Load dataset from a JSON file */
  static async fromJSON(path: string): Promise<EvalDataset> {
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      metadata: DatasetMetadata
      entries: EvalEntry[]
    }
    return new EvalDataset(raw.metadata, raw.entries)
  }

  /**
   * Load dataset from a JSONL file (one JSON object per line).
   * First line may be metadata (if it has a "name" field); otherwise all lines are entries.
   */
  static async fromJSONL(path: string): Promise<EvalDataset> {
    const { readFile } = await import('node:fs/promises')
    const lines = (await readFile(path, 'utf8'))
      .split('\n')
      .filter(line => line.trim().length > 0)

    const entries: EvalEntry[] = []
    let metadata: DatasetMetadata | null = null

    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (!metadata && typeof obj['name'] === 'string' && typeof obj['version'] === 'string') {
        metadata = obj as unknown as DatasetMetadata
      } else {
        entries.push({
          id: (obj['id'] as string) ?? `entry-${entries.length}`,
          input: obj['input'] as string,
          output: obj['output'] as string,
          reference: obj['reference'] as string | undefined,
          context: obj['context'] as string | undefined,
          tags: obj['tags'] as string[] | undefined,
          metadata: obj['metadata'] as Record<string, unknown> | undefined,
        })
      }
    }

    return new EvalDataset(
      metadata ?? { name: path, version: '1.0.0', createdAt: new Date().toISOString() },
      entries,
    )
  }

  /**
   * Load dataset from a CSV file.
   * Expected columns: id, input, output, reference, context, tags (comma-separated in quotes)
   */
  static async fromCSV(path: string): Promise<EvalDataset> {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(path, 'utf8')
    const entries = parseCSV(text)
    return new EvalDataset(
      { name: path, version: '1.0.0', createdAt: new Date().toISOString() },
      entries,
    )
  }

  /** Create a dataset from an inline array (useful for tests) */
  static from(entries: EvalEntry[], name?: string): EvalDataset {
    return new EvalDataset(
      { name: name ?? 'inline', version: '1.0.0', createdAt: new Date().toISOString() },
      entries,
    )
  }
}

/** Seeded PRNG for reproducible sampling */
function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}

/** Parse CSV text into EvalEntry array */
function parseCSV(text: string): EvalEntry[] {
  // Implementation: header detection, field parsing, tag splitting
  throw new Error('Implementation placeholder')
}
```

**Dataset file format (JSONL):**

```jsonl
{"name": "qa-basic-v1", "version": "1.0.0", "description": "Basic QA test cases", "createdAt": "2026-03-24"}
{"id": "qa-001", "input": "What is TypeScript?", "output": "", "reference": "TypeScript is a typed superset of JavaScript", "tags": ["basics", "definitions"]}
{"id": "qa-002", "input": "Explain async/await", "output": "", "reference": "async/await is syntactic sugar for Promises", "tags": ["basics", "async"]}
```

---

### F5: Eval Runner (P1, 8h)

**Owner:** `@dzipagent/evals`
**Files:** `src/runner/eval-runner.ts`, `src/runner/eval-report.ts`

Enhances the existing `EvalRunner` with concurrency control, dataset-aware evaluation, progress events, structured reporting, and CI/CD exit mode.

```typescript
// @dzipagent/evals/src/runner/eval-runner.ts (enhanced)

import type {
  Scorer,
  ScorerResult,
  EvalInput,
  EvalRecord,
  EvalResultStore,
} from '../types.js'
import type { EvalDataset, EvalEntry } from '../dataset/eval-dataset.js'
import type { EvalReport, EvalReportEntry } from './eval-report.js'

/**
 * Configuration for an eval run.
 */
export interface EvalRunConfig {
  /** Unique identifier for this eval run (auto-generated if not provided) */
  runId?: string
  /** Maximum concurrent scorer evaluations (default: 5) */
  concurrency?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Progress callback -- called after each entry is evaluated */
  onProgress?: (progress: EvalProgress) => void
  /** Whether to persist results to the store (default: true if store provided) */
  persist?: boolean
  /** CI mode: throw if any scorer falls below its threshold (default: false) */
  ciMode?: boolean
  /** Baseline to compare against for regression detection */
  baseline?: Map<string, number>
}

/**
 * Progress report emitted during evaluation.
 */
export interface EvalProgress {
  /** Current entry index (0-based) */
  current: number
  /** Total entries */
  total: number
  /** Percentage complete (0-100) */
  percent: number
  /** Entry that was just evaluated */
  entry: EvalEntry | EvalInput
  /** Results for this entry */
  results: ScorerResult[]
  /** Elapsed time in ms */
  elapsedMs: number
}

/**
 * Enhanced EvalRunner with concurrency, datasets, reporting, and CI mode.
 *
 * @example Basic usage
 * ```ts
 * const runner = new EvalRunner([faithfulness, relevance])
 * const results = await runner.evaluate({ input: 'task', output: 'response' })
 * ```
 *
 * @example Dataset evaluation with progress
 * ```ts
 * const runner = new EvalRunner(scorers, store)
 * const report = await runner.evaluateDataset(dataset, {
 *   concurrency: 10,
 *   onProgress: (p) => console.log(`${p.percent}% complete`),
 * })
 * ```
 *
 * @example CI mode with regression detection
 * ```ts
 * const report = await runner.evaluateDataset(dataset, {
 *   ciMode: true,
 *   baseline: new Map([['faithfulness', 0.85], ['relevance', 0.80]]),
 * })
 * // Throws EvalRegressionError if scores drop below baseline
 * ```
 */
export class EvalRunner {
  constructor(
    private scorers: Array<Scorer<EvalInput>>,
    private store?: EvalResultStore,
  ) {}

  /** Evaluate a single input across all scorers */
  async evaluate(input: EvalInput): Promise<ScorerResult[]> {
    const results = await Promise.all(
      this.scorers.map(s => s.evaluate(input)),
    )

    if (this.store) {
      await this.store.save({
        id: crypto.randomUUID(),
        input,
        results,
        timestamp: new Date(),
      })
    }

    return results
  }

  /**
   * Evaluate an entire dataset with concurrency control and progress tracking.
   * Returns a structured EvalReport.
   */
  async evaluateDataset(
    dataset: EvalDataset,
    config?: EvalRunConfig,
  ): Promise<EvalReport> {
    const runId = config?.runId ?? crypto.randomUUID()
    const concurrency = config?.concurrency ?? 5
    const startTime = Date.now()
    const entries: EvalReportEntry[] = []

    // Process entries with concurrency limit
    const queue = [...dataset.entries]
    let completed = 0

    const processEntry = async (entry: EvalEntry): Promise<EvalReportEntry> => {
      if (config?.signal?.aborted) {
        throw new Error('Eval run aborted')
      }

      const entryStart = Date.now()
      const results = await Promise.all(
        this.scorers.map(s => s.evaluate(entry)),
      )
      const entryDurationMs = Date.now() - entryStart

      completed++
      config?.onProgress?.({
        current: completed,
        total: dataset.size,
        percent: Math.round((completed / dataset.size) * 100),
        entry,
        results,
        elapsedMs: Date.now() - startTime,
      })

      return {
        entryId: entry.id,
        input: entry,
        results,
        durationMs: entryDurationMs,
      }
    }

    // Execute with concurrency limit
    const results = await executeWithConcurrency(
      queue.map(entry => () => processEntry(entry)),
      concurrency,
    )
    entries.push(...results)

    // Build report
    const report = buildEvalReport(runId, dataset, this.scorers, entries, Date.now() - startTime)

    // Persist results
    if (this.store && config?.persist !== false) {
      for (const entry of entries) {
        await this.store.save({
          id: crypto.randomUUID(),
          input: entry.input,
          results: entry.results,
          timestamp: new Date(),
          runId,
        })
      }
    }

    // Regression detection
    if (config?.baseline) {
      report.regressions = detectRegressions(report, config.baseline)
    }

    // CI mode: exit with error if regressions detected
    if (config?.ciMode && report.regressions && report.regressions.length > 0) {
      throw new EvalRegressionError(report.regressions, report)
    }

    return report
  }

  /**
   * Compare two eval reports to detect regressions.
   */
  static compare(current: EvalReport, previous: EvalReport): EvalComparison {
    const changes: EvalScorerChange[] = []

    for (const [scorerId, currentAvg] of Object.entries(current.aggregates.byScorerAverage)) {
      const previousAvg = previous.aggregates.byScorerAverage[scorerId]
      if (previousAvg !== undefined) {
        changes.push({
          scorerId,
          previousAvg,
          currentAvg,
          delta: currentAvg - previousAvg,
          regression: currentAvg < previousAvg,
        })
      }
    }

    return {
      currentRunId: current.runId,
      previousRunId: previous.runId,
      changes,
      hasRegressions: changes.some(c => c.regression),
    }
  }
}

/**
 * Error thrown when CI mode detects regressions.
 */
export class EvalRegressionError extends Error {
  constructor(
    readonly regressions: string[],
    readonly report: EvalReport,
  ) {
    super(
      `Eval regression detected:\n${regressions.map(r => `  - ${r}`).join('\n')}`,
    )
    this.name = 'EvalRegressionError'
  }
}

export interface EvalComparison {
  currentRunId: string
  previousRunId: string
  changes: EvalScorerChange[]
  hasRegressions: boolean
}

export interface EvalScorerChange {
  scorerId: string
  previousAvg: number
  currentAvg: number
  delta: number
  regression: boolean
}

/** Execute async tasks with a concurrency limit */
async function executeWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = []
  const executing: Set<Promise<void>> = new Set()

  for (const task of tasks) {
    const p = task().then(result => {
      results.push(result)
      executing.delete(p)
    })
    executing.add(p)

    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  await Promise.all(executing)
  return results
}

// buildEvalReport and detectRegressions are internal helpers
// that construct the EvalReport from raw entry results.
```

**EvalReport structure:**

```typescript
// @dzipagent/evals/src/runner/eval-report.ts

import type { ScorerResult, EvalInput, ScorerConfig } from '../types.js'
import type { DatasetMetadata } from '../dataset/eval-dataset.js'

/**
 * A single entry in an evaluation report.
 */
export interface EvalReportEntry {
  /** Entry ID from the dataset */
  entryId: string
  /** The evaluated input */
  input: EvalInput
  /** Results from all scorers */
  results: ScorerResult[]
  /** Time taken to evaluate this entry */
  durationMs: number
}

/**
 * Aggregate statistics for an eval report.
 */
export interface EvalAggregates {
  /** Total entries evaluated */
  totalEntries: number
  /** Entries where ALL scorers passed */
  totalPassed: number
  /** Entries where at least one scorer failed */
  totalFailed: number
  /** Pass rate as percentage (0-100) */
  passRate: number
  /** Average score per scorer */
  byScorerAverage: Record<string, number>
  /** Pass count per scorer */
  byScorerPassed: Record<string, number>
  /** Fail count per scorer */
  byScorerFailed: Record<string, number>
  /** P50/P90/P99 latencies */
  latencyPercentiles?: {
    p50Ms: number
    p90Ms: number
    p99Ms: number
  }
  /** Total cost of all evaluations (scorer calls, not agent calls) */
  totalCostCents?: number
  /** Total duration of the eval run */
  totalDurationMs: number
}

/**
 * Complete evaluation report.
 *
 * This is the primary output of `EvalRunner.evaluateDataset()`. Contains
 * all entry results, aggregate statistics, and regression information.
 */
export interface EvalReport {
  /** Unique identifier for this eval run */
  runId: string
  /** When this eval was performed */
  timestamp: string
  /** Dataset metadata */
  dataset: DatasetMetadata
  /** Scorer configurations used in this eval */
  scorers: ScorerConfig[]
  /** Per-entry results */
  entries: EvalReportEntry[]
  /** Aggregate statistics */
  aggregates: EvalAggregates
  /** Regression details (populated when baseline is provided) */
  regressions?: string[]
}

/**
 * Render an eval report as a markdown table.
 *
 * @example Output:
 * ```markdown
 * ## Eval Report: qa-basic-v1 (run abc123)
 *
 * | Scorer | Avg Score | Passed | Failed | Threshold |
 * |--------|-----------|--------|--------|-----------|
 * | faithfulness | 0.87 | 48 | 2 | 0.80 |
 * | relevance | 0.92 | 50 | 0 | 0.70 |
 *
 * **Overall:** 96% pass rate (48/50 entries all-pass)
 * ```
 */
export function reportToMarkdown(report: EvalReport): string {
  const lines: string[] = [
    `## Eval Report: ${report.dataset.name} (run ${report.runId.slice(0, 8)})`,
    '',
    `**Date:** ${report.timestamp}`,
    `**Entries:** ${report.aggregates.totalEntries}`,
    `**Duration:** ${report.aggregates.totalDurationMs}ms`,
    '',
    '| Scorer | Avg Score | Passed | Failed | Threshold |',
    '|--------|-----------|--------|--------|-----------|',
  ]

  for (const scorer of report.scorers) {
    const avg = report.aggregates.byScorerAverage[scorer.id] ?? 0
    const passed = report.aggregates.byScorerPassed[scorer.id] ?? 0
    const failed = report.aggregates.byScorerFailed[scorer.id] ?? 0
    lines.push(
      `| ${scorer.name} | ${avg.toFixed(2)} | ${passed} | ${failed} | ${scorer.threshold} |`,
    )
  }

  lines.push('')
  lines.push(
    `**Overall:** ${report.aggregates.passRate.toFixed(0)}% pass rate ` +
    `(${report.aggregates.totalPassed}/${report.aggregates.totalEntries} entries all-pass)`,
  )

  if (report.regressions && report.regressions.length > 0) {
    lines.push('')
    lines.push('### Regressions')
    for (const r of report.regressions) {
      lines.push(`- ${r}`)
    }
  }

  return lines.join('\n')
}

/**
 * Convert report to JSON for machine consumption (CI artifacts, dashboards).
 */
export function reportToJSON(report: EvalReport): string {
  return JSON.stringify(report, null, 2)
}

/**
 * Generate GitHub Actions annotations from report failures.
 * Each failing entry produces a ::warning annotation.
 */
export function reportToAnnotations(report: EvalReport): string[] {
  const annotations: string[] = []

  for (const entry of report.entries) {
    for (const result of entry.results) {
      if (!result.passed) {
        annotations.push(
          `::warning title=Eval failure: ${result.scorerId}::` +
          `Entry "${entry.entryId}" scored ${result.aggregateScore.toFixed(2)} ` +
          `(threshold: ${report.scorers.find(s => s.id === result.scorerId)?.threshold ?? '?'})`,
        )
      }
    }
  }

  if (report.regressions) {
    for (const regression of report.regressions) {
      annotations.push(`::error title=Regression detected::${regression}`)
    }
  }

  return annotations
}
```

---

### F6: LLM Recorder (P1, 8h)

**Owner:** `@dzipagent/testing`
**Files:** `src/llm-recorder.ts`, `src/cassette.ts`

Rewrites the existing `LLMRecorder` to fix ESM violations, add JSONL cassette format (multiple fixtures per file), fuzzy matching for non-deterministic requests, recording filters, and integration with `ModelRegistry`.

```typescript
// @dzipagent/testing/src/cassette.ts

/**
 * A cassette stores multiple LLM interaction fixtures in a single JSONL file.
 *
 * Each line is a JSON object representing one request/response pair.
 * Cassettes are named by test file or scenario. Multiple fixtures
 * in one cassette enable multi-turn conversation testing.
 */

/**
 * A single fixture (one LLM call/response pair).
 */
export interface CassetteFixture {
  /** Hash of the request for lookup */
  requestHash: string
  /** Serialized request messages */
  request: CassetteMessage[]
  /** The model's response */
  response: CassetteResponse
  /** Which model produced this response */
  model: string
  /** When this was recorded */
  recordedAt: string
  /** Sequence number within this cassette (for ordering) */
  sequence: number
  /** Request metadata (tool bindings, temperature, etc.) */
  requestMeta?: Record<string, unknown>
}

export interface CassetteMessage {
  role: 'system' | 'human' | 'ai' | 'tool'
  content: string | unknown
  /** Tool call ID (for tool messages) */
  toolCallId?: string
  /** Tool calls (for AI messages with tool use) */
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
}

export interface CassetteResponse {
  content: string
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Load a cassette from a JSONL file.
 * Returns fixtures indexed by request hash.
 */
export async function loadCassette(path: string): Promise<Map<string, CassetteFixture>> {
  const { readFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')

  if (!existsSync(path)) return new Map()

  const text = await readFile(path, 'utf8')
  const fixtures = new Map<string, CassetteFixture>()

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const fixture = JSON.parse(line) as CassetteFixture
    fixtures.set(fixture.requestHash, fixture)
  }

  return fixtures
}

/**
 * Save a fixture to a cassette (append mode).
 */
export async function appendToCassette(path: string, fixture: CassetteFixture): Promise<void> {
  const { appendFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')

  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(fixture) + '\n')
}

/**
 * Save an entire cassette (overwrite mode).
 */
export async function saveCassette(
  path: string,
  fixtures: Map<string, CassetteFixture>,
): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')

  await mkdir(dirname(path), { recursive: true })
  const lines = [...fixtures.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(f => JSON.stringify(f))
  await writeFile(path, lines.join('\n') + '\n')
}
```

```typescript
// @dzipagent/testing/src/llm-recorder.ts (rewritten)

import { createHash } from 'node:crypto'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { CassetteFixture, CassetteMessage, CassetteResponse } from './cassette.js'
import { loadCassette, appendToCassette } from './cassette.js'
import { MockChatModel } from './mock-model.js'

export type RecorderMode = 'record' | 'replay' | 'auto' | 'passthrough'

/**
 * Configuration for the LLM recorder.
 */
export interface RecorderConfig {
  /** Directory or file path for cassette storage */
  cassettePath: string
  /** Operating mode */
  mode: RecorderMode
  /**
   * Custom hash function for request matching.
   * Default: SHA-256 of concatenated message content.
   * For fuzzy matching, override to normalize or omit variable parts.
   */
  hashFn?: (messages: BaseMessage[]) => string
  /**
   * Recording filter -- return false to skip recording certain calls.
   * Useful for excluding embedding calls or system prompts.
   */
  filter?: (messages: BaseMessage[]) => boolean
  /**
   * Fuzzy match tolerance (0-1).
   * 0 = exact hash match only (default).
   * >0 = fall back to edit-distance matching if no exact hash found.
   */
  fuzzyTolerance?: number
}

/**
 * LLM Recorder -- record and replay LLM interactions for deterministic testing.
 *
 * Records LLM call/response pairs to JSONL cassette files. During replay,
 * matches incoming requests to recorded responses by content hash.
 *
 * Modes:
 * - `record`: Always calls the real model, saves responses to cassette
 * - `replay`: Never calls the real model, returns recorded responses
 * - `auto`: Uses recorded response if available, calls real model otherwise (and records)
 * - `passthrough`: Calls the real model, no recording
 *
 * @example
 * ```ts
 * const recorder = new LLMRecorder({
 *   cassettePath: '__fixtures__/llm/code-gen.jsonl',
 *   mode: process.env.LLM_RECORD === '1' ? 'record' : 'replay',
 * })
 *
 * // Wrap a real model for testing
 * const model = await recorder.wrap(new ChatAnthropic({ model: 'claude-haiku-4-5' }))
 * const result = await model.invoke(messages) // deterministic in replay mode
 * ```
 *
 * @example Fuzzy matching
 * ```ts
 * const recorder = new LLMRecorder({
 *   cassettePath: '__fixtures__/llm/qa.jsonl',
 *   mode: 'replay',
 *   hashFn: (messages) => {
 *     // Ignore system prompt differences, hash only user content
 *     const userMsgs = messages.filter(m => m._getType() === 'human')
 *     return hashContent(userMsgs.map(m => m.content).join('|'))
 *   },
 * })
 * ```
 *
 * @example With ModelRegistry integration
 * ```ts
 * import { ModelRegistry } from '@dzipagent/core'
 *
 * const registry = new ModelRegistry()
 * const recorder = new LLMRecorder({ cassettePath: '...', mode: 'replay' })
 *
 * // Wrap all models in the registry
 * const wrappedRegistry = recorder.wrapRegistry(registry)
 * ```
 */
export class LLMRecorder {
  private cassette: Map<string, CassetteFixture> | null = null
  private sequence = 0
  private readonly config: RecorderConfig

  constructor(config: RecorderConfig) {
    this.config = config
  }

  /**
   * Wrap a model with record/replay behavior.
   * Returns a new BaseChatModel that intercepts invoke() calls.
   */
  async wrap(model: BaseChatModel): Promise<BaseChatModel> {
    if (this.config.mode === 'passthrough') return model

    // Lazy-load cassette
    if (!this.cassette) {
      this.cassette = await loadCassette(this.config.cassettePath)
    }

    const self = this
    const cassette = this.cassette

    return new RecorderModel(model, self, cassette)
  }

  /**
   * Hash messages for cassette lookup.
   */
  hashMessages(messages: BaseMessage[]): string {
    if (this.config.hashFn) return this.config.hashFn(messages)
    const content = messages.map(m => {
      const c = m.content
      return typeof c === 'string' ? c : JSON.stringify(c)
    }).join('|')
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /**
   * Check if a request should be recorded (respects filter config).
   */
  shouldRecord(messages: BaseMessage[]): boolean {
    if (this.config.filter) return this.config.filter(messages)
    return true
  }

  /**
   * Get the next sequence number for cassette ordering.
   */
  nextSequence(): number {
    return this.sequence++
  }

  /**
   * List all fixture hashes in the loaded cassette.
   */
  async listFixtureHashes(): Promise<string[]> {
    if (!this.cassette) {
      this.cassette = await loadCassette(this.config.cassettePath)
    }
    return [...this.cassette.keys()]
  }

  /**
   * Get cassette statistics.
   */
  async stats(): Promise<{ fixtureCount: number; models: string[] }> {
    if (!this.cassette) {
      this.cassette = await loadCassette(this.config.cassettePath)
    }
    const models = new Set<string>()
    for (const f of this.cassette.values()) {
      models.add(f.model)
    }
    return { fixtureCount: this.cassette.size, models: [...models] }
  }
}

/**
 * Internal model wrapper that handles record/replay logic.
 */
class RecorderModel extends MockChatModel {
  constructor(
    private readonly realModel: BaseChatModel,
    private readonly recorder: LLMRecorder,
    private readonly cassette: Map<string, CassetteFixture>,
  ) {
    super([''])
  }

  async _generate(
    messages: BaseMessage[],
  ): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    const hash = this.recorder.hashMessages(messages)
    const mode = (this.recorder as unknown as { config: RecorderConfig }).config.mode
    const cassettePath = (this.recorder as unknown as { config: RecorderConfig }).config.cassettePath

    // Check for existing fixture
    const existing = this.cassette.get(hash)

    if (mode === 'replay') {
      if (!existing) {
        throw new Error(
          `No cassette fixture for hash "${hash}". ` +
          `Run tests with LLM_RECORD=1 to record fixtures. ` +
          `Cassette: ${cassettePath}`,
        )
      }
      return fixtureToGeneration(existing)
    }

    if (mode === 'auto' && existing) {
      return fixtureToGeneration(existing)
    }

    // Record mode or auto without existing fixture
    if (!this.recorder.shouldRecord(messages)) {
      // Call real model but do not record
      return callRealModel(this.realModel, messages)
    }

    const result = await callRealModel(this.realModel, messages)
    const content = result.generations[0]?.text ?? ''

    const fixture: CassetteFixture = {
      requestHash: hash,
      request: serializeMessages(messages),
      response: {
        content,
        toolCalls: result.generations[0]?.message.tool_calls?.map(tc => ({
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args as Record<string, unknown>,
        })),
      },
      model: this.realModel._llmType?.() ?? 'unknown',
      recordedAt: new Date().toISOString(),
      sequence: this.recorder.nextSequence(),
    }

    this.cassette.set(hash, fixture)
    await appendToCassette(cassettePath, fixture)

    return result
  }
}

/** Convert messages to serializable format */
function serializeMessages(messages: BaseMessage[]): CassetteMessage[] {
  return messages.map(m => ({
    role: m._getType() as CassetteMessage['role'],
    content: m.content,
  }))
}

/** Convert a cassette fixture back to a generation result */
function fixtureToGeneration(
  fixture: CassetteFixture,
): { generations: Array<{ text: string; message: AIMessage }> } {
  const message = new AIMessage({
    content: fixture.response.content,
    tool_calls: fixture.response.toolCalls,
  })
  return { generations: [{ text: fixture.response.content, message }] }
}

/** Call the real model and return a generation result */
async function callRealModel(
  model: BaseChatModel,
  messages: BaseMessage[],
): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
  const result = await model.invoke(messages)
  const content = typeof result.content === 'string'
    ? result.content
    : JSON.stringify(result.content)
  return {
    generations: [{
      text: content,
      message: result instanceof AIMessage ? result : new AIMessage({ content }),
    }],
  }
}
```

---

### F7: Mock Models (P1, 4h)

**Owner:** `@dzipagent/testing`
**File:** `src/mock-model.ts`

Enhances the existing `MockChatModel` with pattern-matched responses, error simulation, latency simulation, and Vitest assertion integration.

```typescript
// @dzipagent/testing/src/mock-model.ts (enhanced)

import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'

/**
 * A single mock response. Can be a plain string or a structured response
 * with tool calls.
 */
export interface MockResponse {
  content: string
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
}

/**
 * A pattern-matched response rule. When the input matches the pattern,
 * the corresponding response is returned.
 */
export interface ResponseRule {
  /** Pattern to match against the last message content */
  match: RegExp | string | ((messages: BaseMessage[]) => boolean)
  /** Response to return when matched */
  response: string | MockResponse
}

/**
 * Error simulation configuration.
 */
export interface ErrorSimulation {
  /** Simulated error type */
  type: 'rate-limited' | 'timeout' | 'server-error' | 'malformed' | 'auth-error'
  /** Trigger on Nth call (1-based), or 'random' with probability, or 'always' */
  trigger: number | 'always' | { probability: number }
  /** Error message */
  message?: string
  /** For rate-limited: retry-after header value in seconds */
  retryAfterSeconds?: number
}

/**
 * Configuration for MockChatModel.
 */
export interface MockChatModelConfig {
  /** Static responses returned in sequence (cycles back to first) */
  responses?: Array<string | MockResponse>
  /** Pattern-matched response rules (checked before static responses) */
  rules?: ResponseRule[]
  /** Error simulation */
  errors?: ErrorSimulation[]
  /** Simulated latency in ms (default: 0) */
  latencyMs?: number
  /** Simulated tokens for usage tracking */
  tokensPerResponse?: { input: number; output: number }
}

/**
 * A call log entry recording what was sent to the mock model.
 */
export interface MockCallLogEntry {
  messages: BaseMessage[]
  timestamp: number
  responseContent: string
  durationMs: number
  error?: Error
}

/**
 * MockChatModel -- deterministic chat model for testing.
 *
 * Supports multiple response modes:
 * 1. **Sequential:** Returns responses in order, cycling back to the first
 * 2. **Pattern-matched:** Matches input against rules, returns corresponding response
 * 3. **Error simulation:** Simulates API errors (rate limits, timeouts, etc.)
 *
 * All calls are logged for assertion in tests.
 *
 * @example Sequential responses
 * ```ts
 * const model = new MockChatModel({
 *   responses: ['First response', 'Second response'],
 * })
 * ```
 *
 * @example Pattern-matched responses
 * ```ts
 * const model = new MockChatModel({
 *   rules: [
 *     { match: /code review/i, response: 'LGTM! The code looks good.' },
 *     { match: /generate.*component/i, response: '<template>...</template>' },
 *   ],
 *   responses: ['Default response for unmatched inputs'],
 * })
 * ```
 *
 * @example Error simulation
 * ```ts
 * const model = new MockChatModel({
 *   responses: ['Success response'],
 *   errors: [
 *     { type: 'rate-limited', trigger: 1, retryAfterSeconds: 5 },
 *     // First call gets rate-limited, subsequent calls succeed
 *   ],
 * })
 * ```
 *
 * @example Vitest assertions
 * ```ts
 * const model = new MockChatModel({ responses: ['ok'] })
 * await agent.generate([new HumanMessage('test')])
 *
 * expect(model.callCount).toBe(1)
 * expect(model.lastCall?.messages[0]?.content).toContain('test')
 * model.assertCalledWith('test') // shorthand
 * ```
 */
export class MockChatModel extends BaseChatModel {
  private config: MockChatModelConfig
  private callIndex = 0
  private _callLog: MockCallLogEntry[] = []

  static lc_name(): string {
    return 'MockChatModel'
  }

  constructor(configOrResponses: MockChatModelConfig | Array<string | MockResponse>) {
    super({})
    if (Array.isArray(configOrResponses)) {
      this.config = { responses: configOrResponses }
    } else {
      this.config = configOrResponses
    }
    if (!this.config.responses || this.config.responses.length === 0) {
      this.config.responses = [{ content: '' }]
    }
  }

  async _generate(
    messages: BaseMessage[],
    _options?: BaseChatModelCallOptions,
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    const startTime = Date.now()
    this.callIndex++

    // Check for error simulation
    if (this.config.errors) {
      const error = this.shouldError(this.callIndex)
      if (error) {
        const logEntry: MockCallLogEntry = {
          messages: [...messages],
          timestamp: Date.now(),
          responseContent: '',
          durationMs: 0,
          error,
        }
        this._callLog.push(logEntry)
        throw error
      }
    }

    // Simulate latency
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.latencyMs))
    }

    // Check pattern-matched rules first
    let response: MockResponse | undefined
    if (this.config.rules) {
      for (const rule of this.config.rules) {
        if (matchesRule(rule, messages)) {
          response = typeof rule.response === 'string'
            ? { content: rule.response }
            : rule.response
          break
        }
      }
    }

    // Fall back to sequential responses
    if (!response) {
      const responses = this.config.responses!.map(r =>
        typeof r === 'string' ? { content: r } : r,
      )
      response = responses[(this.callIndex - 1) % responses.length]!
    }

    const durationMs = Date.now() - startTime

    this._callLog.push({
      messages: [...messages],
      timestamp: Date.now(),
      responseContent: response.content,
      durationMs,
    })

    const aiMessage = new AIMessage({
      content: response.content,
      tool_calls: response.toolCalls,
      usage_metadata: this.config.tokensPerResponse
        ? {
            input_tokens: this.config.tokensPerResponse.input,
            output_tokens: this.config.tokensPerResponse.output,
            total_tokens: this.config.tokensPerResponse.input + this.config.tokensPerResponse.output,
          }
        : undefined,
    })

    return {
      generations: [{ text: response.content, message: aiMessage }],
    }
  }

  _llmType(): string {
    return 'mock'
  }

  // --- Call tracking and assertions ---

  /** Get the log of all calls made to this model */
  get callLog(): readonly MockCallLogEntry[] {
    return this._callLog
  }

  /** Number of times invoke/generate was called */
  get callCount(): number {
    return this._callLog.length
  }

  /** Get the most recent call */
  get lastCall(): MockCallLogEntry | undefined {
    return this._callLog[this._callLog.length - 1]
  }

  /** Get the Nth call (0-based) */
  nthCall(n: number): MockCallLogEntry | undefined {
    return this._callLog[n]
  }

  /** Reset call counter, log, and sequence index */
  reset(): void {
    this.callIndex = 0
    this._callLog = []
  }

  /**
   * Assert that the model was called with messages containing the given text.
   * Throws if no matching call is found.
   */
  assertCalledWith(text: string): void {
    const found = this._callLog.some(entry =>
      entry.messages.some(m => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return content.includes(text)
      }),
    )
    if (!found) {
      throw new Error(
        `Expected MockChatModel to be called with text containing "${text}", ` +
        `but it was not found in ${this._callLog.length} call(s).`,
      )
    }
  }

  /**
   * Assert that the model was called exactly N times.
   */
  assertCallCount(expected: number): void {
    if (this._callLog.length !== expected) {
      throw new Error(
        `Expected MockChatModel to be called ${expected} time(s), ` +
        `but it was called ${this._callLog.length} time(s).`,
      )
    }
  }

  /**
   * Assert that the model was never called.
   */
  assertNotCalled(): void {
    if (this._callLog.length > 0) {
      throw new Error(
        `Expected MockChatModel to not be called, ` +
        `but it was called ${this._callLog.length} time(s).`,
      )
    }
  }

  // --- Internal ---

  private shouldError(callNumber: number): Error | undefined {
    for (const sim of this.config.errors ?? []) {
      if (sim.trigger === 'always') return makeSimulatedError(sim)
      if (typeof sim.trigger === 'number' && sim.trigger === callNumber) return makeSimulatedError(sim)
      if (typeof sim.trigger === 'object' && Math.random() < sim.trigger.probability) return makeSimulatedError(sim)
    }
    return undefined
  }
}

function matchesRule(rule: ResponseRule, messages: BaseMessage[]): boolean {
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage) return false
  const content = typeof lastMessage.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage.content)

  if (typeof rule.match === 'function') return rule.match(messages)
  if (typeof rule.match === 'string') return content.includes(rule.match)
  return rule.match.test(content)
}

function makeSimulatedError(sim: ErrorSimulation): Error {
  const msg = sim.message ?? `Simulated ${sim.type} error`
  const err = new Error(msg)
  err.name = sim.type
  if (sim.type === 'rate-limited') {
    (err as Record<string, unknown>)['retryAfter'] = sim.retryAfterSeconds ?? 60
    (err as Record<string, unknown>)['status'] = 429
  }
  if (sim.type === 'timeout') {
    (err as Record<string, unknown>)['status'] = 408
  }
  if (sim.type === 'server-error') {
    (err as Record<string, unknown>)['status'] = 500
  }
  return err
}
```

---

### F8: Integration Test Harness (P1, 8h)

**Owner:** `@dzipagent/testing`
**Files:** `src/harness/test-dzip-agent.ts`, `src/harness/test-mcp-server.ts`, `src/harness/test-a2a-server.ts`, `src/harness/scenario-runner.ts`, `src/harness/assertions.ts`

Provides pre-configured test doubles for the entire DzipAgent stack: agents, MCP servers, A2A endpoints, and memory stores. Includes a scenario runner for multi-step interaction tests.

```typescript
// @dzipagent/testing/src/harness/test-dzip-agent.ts

import type { BaseMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { DzipAgentConfig, GenerateResult } from '@dzipagent/agent'
import type { DzipEventBus, DzipEvent, RunStore, AgentDefinition } from '@dzipagent/core'
import { MockChatModel, type MockChatModelConfig } from '../mock-model.js'
import { createTestEventBus, createTestRunStore, createTestAgentStore } from '../test-helpers.js'

/**
 * Configuration for a test agent.
 * Extends DzipAgentConfig with test-specific options.
 */
export interface TestDzipAgentConfig {
  /** Agent ID (default: 'test-agent') */
  id?: string
  /** Agent instructions (default: 'You are a test agent.') */
  instructions?: string
  /** Mock model configuration */
  model?: MockChatModelConfig | Array<string | import('../mock-model.js').MockResponse>
  /** Tools available to the agent */
  tools?: StructuredToolInterface[]
  /** Maximum iterations (default: 3 for fast tests) */
  maxIterations?: number
  /** Pre-seeded memory entries */
  seedMemory?: Array<{ namespace: string; key: string; value: Record<string, unknown> }>
}

/**
 * A DzipAgent pre-configured for testing with mock models, captured events,
 * and assertion helpers.
 *
 * @example
 * ```ts
 * const { agent, model, events } = createTestDzipAgent({
 *   model: ['Here is the answer.'],
 *   tools: [myTool],
 * })
 *
 * const result = await agent.generate([new HumanMessage('test question')])
 *
 * expect(result.content).toContain('answer')
 * expect(model.callCount).toBe(1)
 * expect(events).toContainEqual(expect.objectContaining({ type: 'agent:completed' }))
 * ```
 */
export interface TestDzipAgentResult {
  /** The configured DzipAgent instance */
  agent: import('@dzipagent/agent').DzipAgent
  /** The mock model (for call assertions) */
  model: MockChatModel
  /** Captured events from the event bus */
  events: DzipEvent[]
  /** The event bus */
  eventBus: DzipEventBus
  /** The run store */
  runStore: RunStore
  /** Helper to generate and automatically assert no errors */
  generateAndAssert: (messages: BaseMessage[]) => Promise<GenerateResult>
}

/**
 * Create a pre-configured DzipAgent for testing.
 *
 * Wires up mock model, event bus, run store, and optionally seeds memory.
 * Returns the agent plus all internal components for assertions.
 */
export function createTestDzipAgent(config?: TestDzipAgentConfig): TestDzipAgentResult {
  // Implementation: creates MockChatModel, DzipAgent, event bus, stores
  // Wires everything together with sensible test defaults
  throw new Error('Implementation placeholder')
}
```

```typescript
// @dzipagent/testing/src/harness/test-mcp-server.ts

/**
 * A mock MCP server that responds to tool list and tool call requests
 * without requiring a real MCP transport.
 *
 * @example
 * ```ts
 * const mcp = new TestMCPServer()
 * mcp.addTool({
 *   name: 'get_weather',
 *   description: 'Get weather for a location',
 *   inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
 *   handler: async (args) => ({ temperature: 72, unit: 'F' }),
 * })
 *
 * // Wire to agent via MCP client bridge
 * const tools = mcp.asTools() // returns StructuredToolInterface[]
 * ```
 */
export interface TestMCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export class TestMCPServer {
  private tools = new Map<string, TestMCPTool>()
  private callLog: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> = []

  addTool(tool: TestMCPTool): void {
    this.tools.set(tool.name, tool)
  }

  removeTool(name: string): void {
    this.tools.delete(name)
  }

  listTools(): TestMCPTool[] {
    return [...this.tools.values()]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`MCP tool not found: ${name}`)
    const result = await tool.handler(args)
    this.callLog.push({ toolName: name, args, result })
    return result
  }

  /** Convert to StructuredToolInterface array for agent consumption */
  asTools(): import('@langchain/core/tools').StructuredToolInterface[] {
    // Implementation: wraps each tool as a LangChain StructuredTool
    throw new Error('Implementation placeholder')
  }

  /** Get the call log for assertions */
  get calls(): readonly Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> {
    return this.callLog
  }

  reset(): void {
    this.callLog = []
  }
}
```

```typescript
// @dzipagent/testing/src/harness/assertions.ts

import type { DzipEvent } from '@dzipagent/core'
import type { MockChatModel, MockCallLogEntry } from '../mock-model.js'
import type { TestMCPServer } from './test-mcp-server.js'

/**
 * Assertion helpers for DzipAgent integration tests.
 * Designed to work with Vitest's expect() but also usable standalone.
 *
 * @example
 * ```ts
 * import { expectToolCall, expectMemoryWrite, expectEvent } from '@dzipagent/testing'
 *
 * expectToolCall(events, 'write_file', { path: /\.vue$/ })
 * expectMemoryWrite(events, 'lessons')
 * expectEvent(events, 'agent:completed')
 * ```
 */

/**
 * Assert that a specific tool was called in the event log.
 *
 * @param events - Captured DzipEvent array
 * @param toolName - Expected tool name
 * @param inputMatch - Optional partial match against tool input
 * @throws Error if no matching tool call is found
 */
export function expectToolCall(
  events: DzipEvent[],
  toolName: string,
  inputMatch?: Record<string, unknown | RegExp>,
): void {
  const toolCalls = events.filter(
    (e): e is Extract<DzipEvent, { type: 'tool:called' }> =>
      e.type === 'tool:called' && e.toolName === toolName,
  )

  if (toolCalls.length === 0) {
    const allTools = events
      .filter((e): e is Extract<DzipEvent, { type: 'tool:called' }> => e.type === 'tool:called')
      .map(e => e.toolName)
    throw new Error(
      `Expected tool "${toolName}" to be called, but it was not. ` +
      `Tools called: [${allTools.join(', ')}]`,
    )
  }

  if (inputMatch) {
    const matched = toolCalls.some(call => {
      const input = call.input as Record<string, unknown>
      return Object.entries(inputMatch).every(([key, expected]) => {
        const actual = input[key]
        if (expected instanceof RegExp) {
          return typeof actual === 'string' && expected.test(actual)
        }
        return actual === expected
      })
    })

    if (!matched) {
      throw new Error(
        `Tool "${toolName}" was called but no call matched the expected input. ` +
        `Expected: ${JSON.stringify(inputMatch)}`,
      )
    }
  }
}

/**
 * Assert that a memory write occurred to a specific namespace.
 */
export function expectMemoryWrite(events: DzipEvent[], namespace: string): void {
  const writes = events.filter(
    (e): e is Extract<DzipEvent, { type: 'memory:written' }> =>
      e.type === 'memory:written' && e.namespace === namespace,
  )

  if (writes.length === 0) {
    throw new Error(
      `Expected memory write to namespace "${namespace}", but none occurred.`,
    )
  }
}

/**
 * Assert that a specific event type was emitted.
 */
export function expectEvent<T extends DzipEvent['type']>(
  events: DzipEvent[],
  type: T,
  match?: Partial<Extract<DzipEvent, { type: T }>>,
): Extract<DzipEvent, { type: T }> {
  const matched = events.filter(e => e.type === type) as Array<Extract<DzipEvent, { type: T }>>

  if (matched.length === 0) {
    throw new Error(
      `Expected event "${type}" to be emitted, but it was not. ` +
      `Events: [${events.map(e => e.type).join(', ')}]`,
    )
  }

  if (match) {
    const found = matched.find(e =>
      Object.entries(match).every(([key, value]) =>
        (e as Record<string, unknown>)[key] === value,
      ),
    )
    if (!found) {
      throw new Error(
        `Event "${type}" was emitted but no instance matched: ${JSON.stringify(match)}`,
      )
    }
    return found
  }

  return matched[0]!
}

/**
 * Assert that no errors were emitted during an agent run.
 */
export function expectNoErrors(events: DzipEvent[]): void {
  const errors = events.filter(e =>
    e.type === 'agent:failed' || e.type === 'tool:error' || e.type === 'memory:error',
  )

  if (errors.length > 0) {
    const messages = errors.map(e => {
      if ('message' in e) return `${e.type}: ${e.message}`
      return e.type
    })
    throw new Error(
      `Expected no errors, but ${errors.length} occurred:\n${messages.join('\n')}`,
    )
  }
}

/**
 * Assert that the MCP server received a tool call.
 */
export function expectMCPToolCall(
  server: TestMCPServer,
  toolName: string,
  argMatch?: Record<string, unknown>,
): void {
  const calls = server.calls.filter(c => c.toolName === toolName)

  if (calls.length === 0) {
    throw new Error(
      `Expected MCP tool "${toolName}" to be called, but it was not.`,
    )
  }

  if (argMatch) {
    const matched = calls.some(c =>
      Object.entries(argMatch).every(([key, value]) => c.args[key] === value),
    )
    if (!matched) {
      throw new Error(
        `MCP tool "${toolName}" was called but no call matched args: ${JSON.stringify(argMatch)}`,
      )
    }
  }
}
```

```typescript
// @dzipagent/testing/src/harness/scenario-runner.ts

import type { BaseMessage } from '@langchain/core/messages'
import { HumanMessage } from '@langchain/core/messages'
import type { DzipEvent } from '@dzipagent/core'
import type { GenerateResult } from '@dzipagent/agent'
import type { TestDzipAgentResult } from './test-dzip-agent.js'

/**
 * A single step in a multi-step agent interaction scenario.
 */
export interface ScenarioStep {
  /** Human-readable step name */
  name: string
  /** Message to send to the agent */
  message: string | BaseMessage
  /**
   * Assertions to run after this step completes.
   * Receives the generate result and the cumulative event log.
   */
  assert?: (result: GenerateResult, events: DzipEvent[]) => void | Promise<void>
  /** Optional delay before this step (ms) */
  delayMs?: number
}

/**
 * A complete test scenario: a sequence of steps run against a test agent.
 *
 * @example
 * ```ts
 * const scenario: Scenario = {
 *   name: 'Multi-turn code review',
 *   steps: [
 *     {
 *       name: 'Initial review request',
 *       message: 'Review this PR for code quality issues.',
 *       assert: (result) => {
 *         expect(result.content).toContain('review')
 *       },
 *     },
 *     {
 *       name: 'Follow-up question',
 *       message: 'What about the error handling?',
 *       assert: (result, events) => {
 *         expectToolCall(events, 'search_code')
 *       },
 *     },
 *   ],
 * }
 *
 * const runner = new ScenarioRunner(testAgent)
 * const results = await runner.run(scenario)
 * expect(results.allPassed).toBe(true)
 * ```
 */
export interface Scenario {
  /** Human-readable scenario name */
  name: string
  /** Description of what this scenario tests */
  description?: string
  /** Ordered steps to execute */
  steps: ScenarioStep[]
  /** Setup hook -- runs before the first step */
  setup?: (agent: TestDzipAgentResult) => void | Promise<void>
  /** Teardown hook -- runs after the last step */
  teardown?: (agent: TestDzipAgentResult) => void | Promise<void>
}

/**
 * Result of a scenario step execution.
 */
export interface StepResult {
  stepName: string
  result: GenerateResult
  events: DzipEvent[]
  durationMs: number
  assertionError?: Error
  passed: boolean
}

/**
 * Result of a complete scenario execution.
 */
export interface ScenarioResult {
  scenarioName: string
  steps: StepResult[]
  totalDurationMs: number
  allPassed: boolean
}

/**
 * Runs multi-step agent interaction scenarios against a TestDzipAgent.
 *
 * Maintains conversation history across steps (messages accumulate).
 * Events are tracked per-step and cumulatively.
 */
export class ScenarioRunner {
  constructor(private readonly testAgent: TestDzipAgentResult) {}

  async run(scenario: Scenario): Promise<ScenarioResult> {
    const startTime = Date.now()
    const stepResults: StepResult[] = []
    const messages: BaseMessage[] = []

    if (scenario.setup) {
      await scenario.setup(this.testAgent)
    }

    for (const step of scenario.steps) {
      if (step.delayMs) {
        await new Promise(resolve => setTimeout(resolve, step.delayMs))
      }

      const msg = typeof step.message === 'string'
        ? new HumanMessage(step.message)
        : step.message
      messages.push(msg)

      // Clear events for per-step tracking
      const eventsBefore = this.testAgent.events.length
      const stepStart = Date.now()

      const result = await this.testAgent.agent.generate(messages)
      const stepDuration = Date.now() - stepStart
      const stepEvents = this.testAgent.events.slice(eventsBefore)

      // Add agent response to conversation history
      messages.push(...result.messages.slice(messages.length))

      let assertionError: Error | undefined
      if (step.assert) {
        try {
          await step.assert(result, this.testAgent.events)
        } catch (err) {
          assertionError = err instanceof Error ? err : new Error(String(err))
        }
      }

      stepResults.push({
        stepName: step.name,
        result,
        events: stepEvents,
        durationMs: stepDuration,
        assertionError,
        passed: !assertionError,
      })
    }

    if (scenario.teardown) {
      await scenario.teardown(this.testAgent)
    }

    return {
      scenarioName: scenario.name,
      steps: stepResults,
      totalDurationMs: Date.now() - startTime,
      allPassed: stepResults.every(s => s.passed),
    }
  }
}
```

---

### F9: Benchmark Suite (P2, 8h)

**Owner:** `@dzipagent/evals`
**Files:** `src/benchmarks/benchmark-types.ts`, `src/benchmarks/code-gen-bench.ts`, `src/benchmarks/memory-bench.ts`, `src/benchmarks/multi-agent-bench.ts`, `src/benchmarks/performance-bench.ts`

Defines standard benchmark definitions for evaluating DzipAgent configurations. Each benchmark is a specialized `EvalDataset` plus purpose-built scorers.

```typescript
// @dzipagent/evals/src/benchmarks/benchmark-types.ts

import type { EvalDataset } from '../dataset/eval-dataset.js'
import type { Scorer, EvalInput, ScorerResult } from '../types.js'
import type { EvalReport } from '../runner/eval-report.js'

/**
 * A benchmark is a named evaluation suite with a fixed dataset and scorers.
 *
 * Benchmarks provide standardized comparison across different agent
 * configurations (models, prompts, tools, memory strategies).
 */
export interface Benchmark {
  /** Unique benchmark identifier */
  id: string
  /** Human-readable name */
  name: string
  /** What this benchmark measures */
  description: string
  /** Category for grouping */
  category: 'code-generation' | 'memory-retrieval' | 'multi-agent' | 'performance' | 'custom'
  /** The evaluation dataset */
  dataset: EvalDataset
  /** Scorers used for this benchmark */
  scorers: Array<Scorer<EvalInput>>
  /** Known baselines for comparison */
  baselines?: Record<string, BenchmarkBaseline>
}

/**
 * A known baseline score for a benchmark.
 * Used for leaderboard comparison and regression detection.
 */
export interface BenchmarkBaseline {
  /** Configuration label (e.g., 'claude-haiku-default', 'gpt-4o-rag-enabled') */
  label: string
  /** Average scores per scorer */
  scores: Record<string, number>
  /** When this baseline was recorded */
  recordedAt: string
  /** Metadata about the configuration */
  config?: Record<string, unknown>
}

/**
 * Result of running a benchmark with a specific configuration.
 */
export interface BenchmarkResult {
  /** Which benchmark was run */
  benchmarkId: string
  /** Configuration label */
  configLabel: string
  /** The eval report */
  report: EvalReport
  /** Comparison against baselines (if baselines exist) */
  comparison?: Record<string, {
    baselineLabel: string
    deltas: Record<string, number>
    improved: string[]
    regressed: string[]
  }>
}

/**
 * Leaderboard entry for cross-configuration comparison.
 */
export interface LeaderboardEntry {
  rank: number
  configLabel: string
  overallScore: number
  scorerBreakdown: Record<string, number>
  totalCostCents: number
  totalDurationMs: number
  timestamp: string
}

/**
 * Run a benchmark against a specific agent configuration.
 *
 * @example
 * ```ts
 * import { codeGenBenchmark, runBenchmark } from '@dzipagent/evals'
 *
 * const result = await runBenchmark(codeGenBenchmark, {
 *   configLabel: 'claude-sonnet-rag',
 *   agent: myAgent,
 *   concurrency: 5,
 * })
 *
 * console.log(result.report.aggregates.passRate) // e.g., 85
 * ```
 */
export interface RunBenchmarkOptions {
  /** Label for this configuration */
  configLabel: string
  /** Function that produces output for each input (usually agent.generate) */
  generate: (input: string) => Promise<{ output: string; latencyMs: number; costCents: number }>
  /** Concurrency for evaluation */
  concurrency?: number
}

export async function runBenchmark(
  benchmark: Benchmark,
  options: RunBenchmarkOptions,
): Promise<BenchmarkResult> {
  // Implementation:
  // 1. For each dataset entry, call options.generate() to produce output
  // 2. Populate EvalInput with output, latencyMs, costCents
  // 3. Run EvalRunner with benchmark scorers
  // 4. Compare against baselines if available
  // 5. Return BenchmarkResult
  throw new Error('Implementation placeholder')
}
```

**Pre-built benchmark definitions:**

```typescript
// @dzipagent/evals/src/benchmarks/code-gen-bench.ts

/**
 * Code Generation Benchmark (inspired by SWE-bench).
 *
 * Tests:
 * - TypeScript function generation from natural language specs
 * - Vue 3 component generation
 * - Express route handler generation
 * - Error handling completeness
 * - Type safety (no `any`)
 *
 * 50 entries across 5 categories, 10 entries each.
 * Scorers: code-correctness (LLM judge), type-safety (deterministic),
 *          completeness (LLM judge), style (deterministic).
 */
export function createCodeGenBenchmark(): Benchmark {
  // Implementation: loads dataset from bundled JSONL, creates scorers
  throw new Error('Implementation placeholder')
}
```

```typescript
// @dzipagent/evals/src/benchmarks/performance-bench.ts

/**
 * Performance Benchmark (CLEAR framework).
 *
 * Measures:
 * - Cost: token usage stays within budget
 * - Latency: response time meets targets
 * - Efficiency: minimal unnecessary LLM calls
 * - Assurance: output meets quality thresholds
 * - Reliability: consistent across repeated runs
 *
 * 20 entries, each run 3 times for consistency scoring.
 */
export function createPerformanceBenchmark(): Benchmark {
  throw new Error('Implementation placeholder')
}
```

---

### F10: CI/CD Integration (P1, 4h)

**Owner:** `@dzipagent/evals`
**Files:** `ci/forge-evals.yml`, `src/cli/eval-cli.ts`

Provides a GitHub Actions workflow template and a CLI entry point for running evaluations in CI/CD pipelines.

**GitHub Actions workflow template:**

```yaml
# .github/workflows/forge-evals.yml
# Run DzipAgent evaluations on PRs and pushes to main.
#
# Usage: copy this file to your .github/workflows/ directory.
# Configure the eval dataset and baseline paths below.

name: DzipAgent Evaluations

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

env:
  EVAL_DATASET: evals/datasets/qa-v1.jsonl
  EVAL_BASELINE: evals/baselines/main.json
  EVAL_CONCURRENCY: 5

jobs:
  eval:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Build packages
        run: npm run build

      - name: Run unit tests
        run: npm test

      - name: Run evaluations
        id: eval
        run: |
          npx forge-eval run \
            --dataset ${{ env.EVAL_DATASET }} \
            --baseline ${{ env.EVAL_BASELINE }} \
            --concurrency ${{ env.EVAL_CONCURRENCY }} \
            --output evals/reports/latest.json \
            --format json,markdown \
            --ci

      - name: Post eval results to PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs')
            const report = fs.readFileSync('evals/reports/latest.md', 'utf8')
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: report,
            })

      - name: Upload eval report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-report
          path: evals/reports/

      - name: Update baseline (main branch only)
        if: github.ref == 'refs/heads/main' && steps.eval.outcome == 'success'
        run: |
          cp evals/reports/latest.json ${{ env.EVAL_BASELINE }}
          git add ${{ env.EVAL_BASELINE }}
          git commit -m "chore: update eval baseline" || true
          git push || true
```

**CLI entry point:**

```typescript
// @dzipagent/evals/src/cli/eval-cli.ts

/**
 * CLI for running DzipAgent evaluations.
 *
 * Usage:
 *   npx forge-eval run --dataset path.jsonl --baseline path.json [--ci]
 *   npx forge-eval compare --current report1.json --previous report2.json
 *   npx forge-eval baseline --report report.json --output baseline.json
 *
 * This is a thin wrapper around EvalRunner that handles file I/O,
 * report formatting, and exit codes for CI/CD.
 */
export interface CLIOptions {
  command: 'run' | 'compare' | 'baseline'
  /** Path to eval dataset (JSONL, JSON, or CSV) */
  dataset?: string
  /** Path to baseline file for regression detection */
  baseline?: string
  /** Output path for report */
  output?: string
  /** Output format(s): json, markdown, or both */
  format?: string
  /** Evaluation concurrency */
  concurrency?: number
  /** CI mode: exit with code 1 on regressions */
  ci?: boolean
  /** Path to scorer configuration file */
  scorers?: string
  /** For compare command: current report path */
  current?: string
  /** For compare command: previous report path */
  previous?: string
  /** For baseline command: input report path */
  report?: string
}

/**
 * Parse CLI arguments and run the appropriate command.
 * Exit codes:
 *   0 = all evaluations passed
 *   1 = one or more regressions detected (CI mode)
 *   2 = configuration error
 */
export async function runCLI(args: string[]): Promise<void> {
  // Implementation: parse args, load dataset/scorers, run evaluation,
  // write report, handle exit codes
  throw new Error('Implementation placeholder')
}
```

---

## 4. Data Models

### 4.1 Score Data Model

```
Score
  value: number (0-1)                -- normalized score
  label?: string                     -- human classification (excellent, good, poor)
  reasoning?: string                 -- why this score was given
  metadata?: Record<string, unknown> -- scorer-specific data

ScorerConfig
  id: string                -- unique identifier
  name: string              -- display name
  description: string       -- what it measures
  type: enum                -- llm | deterministic | composite | statistical
  threshold: number         -- pass/fail cutoff (0-1)
  version?: string          -- for baseline compat

ScorerResult
  scorerId: string          -- which scorer produced this
  scores: Score[]           -- one or more scores (multi-criteria produces many)
  aggregateScore: number    -- weighted average of scores
  passed: boolean           -- aggregateScore >= threshold
  durationMs: number        -- how long scoring took
  costCents?: number        -- LLM judge cost
```

### 4.2 EvalReport Data Model

```
EvalReport
  runId: string             -- unique run identifier
  timestamp: string         -- ISO 8601
  dataset: DatasetMetadata  -- which dataset was used
  scorers: ScorerConfig[]   -- which scorers were used
  entries: EvalReportEntry[]
    entryId: string
    input: EvalInput
    results: ScorerResult[]
    durationMs: number
  aggregates: EvalAggregates
    totalEntries: number
    totalPassed: number
    totalFailed: number
    passRate: number (0-100)
    byScorerAverage: Record<string, number>
    byScorerPassed: Record<string, number>
    byScorerFailed: Record<string, number>
    latencyPercentiles?: { p50Ms, p90Ms, p99Ms }
    totalCostCents?: number
    totalDurationMs: number
  regressions?: string[]
```

### 4.3 Cassette Data Model

```
CassetteFixture (one per JSONL line)
  requestHash: string       -- SHA-256 hash for lookup
  request: CassetteMessage[]
    role: system | human | ai | tool
    content: string | unknown
    toolCallId?: string
    toolCalls?: Array<{ id, name, args }>
  response: CassetteResponse
    content: string
    toolCalls?: Array<{ id, name, args }>
    usage?: { inputTokens, outputTokens }
  model: string
  recordedAt: string (ISO 8601)
  sequence: number
  requestMeta?: Record<string, unknown>
```

### 4.4 Benchmark Result Data Model

```
BenchmarkResult
  benchmarkId: string
  configLabel: string
  report: EvalReport
  comparison?: Record<string, {
    baselineLabel: string
    deltas: Record<string, number>
    improved: string[]
    regressed: string[]
  }>

LeaderboardEntry
  rank: number
  configLabel: string
  overallScore: number (0-1)
  scorerBreakdown: Record<string, number>
  totalCostCents: number
  totalDurationMs: number
  timestamp: string (ISO 8601)
```

---

## 5. Data Flow Diagrams

### 5.1 Eval Runner Execution Flow

```
                     EvalDataset (JSONL)
                          |
                          v
                   +-------------+
                   | EvalRunner  |
                   +-------------+
                          |
             +------------+------------+
             |            |            |
             v            v            v
         Entry 0      Entry 1     Entry N    (concurrency-limited)
             |            |            |
     +-------+-------+   |   +-------+-------+
     |       |       |   |   |       |       |
     v       v       v   |   v       v       v
  Scorer1 Scorer2 ScorerN | Scorer1 Scorer2 ScorerN
     |       |       |   |   |       |       |
     v       v       v   |   v       v       v
  Result  Result  Result  |  Result  Result  Result
     |       |       |   |   |       |       |
     +-------+-------+   |   +-------+-------+
             |            |            |
             v            v            v
         EvalReportEntry  ...   EvalReportEntry
             |
             +----> Aggregate: compute passRate, byScorerAvg, percentiles
             |
             v
         EvalReport
             |
             +----> reportToMarkdown() --> PR comment
             +----> reportToJSON()     --> CI artifact
             +----> reportToAnnotations() --> GitHub annotations
             +----> Regression check vs baseline
                        |
                        +---> CI mode: exit(1) if regressions
```

### 5.2 LLM Recorder Record/Replay Flow

```
TEST CODE
    |
    v
model.invoke(messages)
    |
    v
RecorderModel._generate(messages)
    |
    +--- Compute hash = SHA256(messages.content)
    |
    +--- mode === 'replay'?
    |       |
    |       YES --> Look up hash in cassette Map
    |       |        |
    |       |        +-- FOUND --> return fixtureToGeneration(fixture)
    |       |        |
    |       |        +-- NOT FOUND --> throw Error("No fixture, run LLM_RECORD=1")
    |       |
    |       NO (mode === 'record' or 'auto')
    |            |
    |            +--- mode === 'auto' AND hash exists?
    |            |       |
    |            |       YES --> return cached fixture
    |            |       NO  --> continue to real model
    |            |
    |            +--- filter(messages) === false?
    |            |       |
    |            |       YES --> call real model, do NOT record
    |            |       NO  --> continue
    |            |
    |            +--- Call realModel.invoke(messages)
    |            |
    |            +--- Create CassetteFixture { hash, request, response, model, timestamp }
    |            |
    |            +--- appendToCassette(path, fixture)
    |            |
    |            +--- Return generation result
```

### 5.3 CI/CD Evaluation Pipeline

```
PR Opened
    |
    v
GitHub Actions Trigger
    |
    +----> Checkout code
    |
    +----> Install + Build
    |
    +----> Run unit tests (vitest, mock models only)
    |            |
    |            +-- FAIL --> exit, no evals
    |            +-- PASS --> continue
    |
    +----> npx forge-eval run
    |        |
    |        +----> Load dataset (JSONL)
    |        +----> Load scorers (config file or defaults)
    |        +----> Load baseline (JSON, from main branch)
    |        +----> EvalRunner.evaluateDataset(dataset, { ciMode: true, baseline })
    |        |        |
    |        |        +----> For each entry: run all scorers
    |        |        +----> Aggregate results
    |        |        +----> Compare vs baseline
    |        |        |
    |        |        +-- Regression? --> throw EvalRegressionError
    |        |        +-- No regression --> return EvalReport
    |        |
    |        +----> Write report (JSON + Markdown)
    |        +----> Write annotations (GitHub ::warning / ::error)
    |        +----> Exit code: 0 (pass) or 1 (regression)
    |
    +----> Post PR comment with markdown report
    |
    +----> Upload report artifact
    |
    +----> (main branch only) Update baseline file
```

---

## 6. File Structure

### 6.1 `@dzipagent/evals` Package

```
packages/forgeagent-evals/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                          # Public API barrel
    types.ts                          # Core types: Score, ScorerConfig, ScorerResult, EvalInput, etc.
    scorers/
      index.ts                        # Scorer barrel
      llm-judge.ts                    # createLLMJudge(), JudgeCriterion, JudgeRubric
      criteria.ts                     # Pre-built criteria: STANDARD_CRITERIA, CODE_CRITERIA, CLEAR_CRITERIA
      deterministic.ts                # createDeterministicScorer, JSONSchema, Keyword, Latency, Cost scorers
      composite.ts                    # createCompositeScorer()
    dataset/
      index.ts                        # Dataset barrel
      eval-dataset.ts                 # EvalDataset class, loaders (JSON, JSONL, CSV)
    runner/
      index.ts                        # Runner barrel
      eval-runner.ts                  # EvalRunner class (batch, concurrency, CI mode)
      eval-report.ts                  # EvalReport, reportToMarkdown, reportToJSON, reportToAnnotations
    benchmarks/
      index.ts                        # Benchmark barrel
      benchmark-types.ts              # Benchmark, BenchmarkResult, LeaderboardEntry, runBenchmark()
      code-gen-bench.ts               # Code generation benchmark (SWE-bench inspired)
      memory-bench.ts                 # Memory retrieval accuracy benchmark
      multi-agent-bench.ts            # Multi-agent coordination benchmark
      performance-bench.ts            # CLEAR performance benchmark
    cli/
      eval-cli.ts                     # CLI entry point: forge-eval command
    stores/
      in-memory-eval-store.ts         # InMemoryEvalResultStore implementation
    __tests__/
      scorers.test.ts                 # Existing + new scorer tests
      eval-runner.test.ts             # Existing + enhanced runner tests
      dataset.test.ts                 # Dataset loading and filtering tests
      report.test.ts                  # Report formatting tests
      benchmarks.test.ts              # Benchmark runner tests
```

### 6.2 `@dzipagent/testing` Package

```
packages/forgeagent-testing/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                          # Public API barrel
    mock-model.ts                     # MockChatModel (enhanced: patterns, errors, latency)
    llm-recorder.ts                   # LLMRecorder (rewritten: cassette format, fuzzy match)
    cassette.ts                       # Cassette JSONL format: load, save, append
    test-helpers.ts                   # Existing: createTestEventBus, createTestRunStore, etc.
    harness/
      index.ts                        # Harness barrel
      test-dzip-agent.ts             # createTestDzipAgent() factory
      test-mcp-server.ts              # TestMCPServer mock
      test-a2a-server.ts              # TestA2AServer mock (future)
      scenario-runner.ts              # ScenarioRunner for multi-step tests
      assertions.ts                   # expectToolCall, expectMemoryWrite, expectEvent, etc.
    __tests__/
      mock-model.test.ts              # Existing + new mock model tests
      llm-recorder.test.ts            # Recorder record/replay tests
      cassette.test.ts                # Cassette format tests
      harness.test.ts                 # Integration harness tests
      scenario-runner.test.ts         # Scenario runner tests
      assertions.test.ts              # Assertion helper tests
```

### 6.3 Shared Test Fixtures

```
evals/
  datasets/                           # Evaluation datasets
    qa-basic-v1.jsonl                 # Basic QA test cases
    code-gen-v1.jsonl                 # Code generation test cases
  baselines/                          # Baseline snapshots
    main.json                         # Latest baseline from main branch
  reports/                            # Generated reports (gitignored)
    latest.json
    latest.md
```

---

## 7. Package Design

### 7.1 `@dzipagent/evals`

**Purpose:** Evaluation framework for measuring agent quality.

**Dependencies:**
- `@dzipagent/core` (direct) -- for `DzipEvent` types (optional, for event-based scoring)
- `@langchain/core` (peer) -- for `BaseChatModel` in LLM judge scorer
- `zod` (peer, optional) -- for JSON schema validation if consumer provides Zod schemas

**Exports (public API):**
```typescript
// Types
export type { Score, ScorerConfig, ScorerResult, Scorer, EvalInput, EvalResult, EvalRecord, EvalResultStore, EvalResultFilter }

// Scorers
export { createLLMJudge, createDeterministicScorer, createCompositeScorer }
export { createJSONSchemaScorer, createKeywordScorer, createLatencyScorer, createCostScorer }
export { containsScorer, jsonValidScorer, lengthScorer, regexScorer, exactMatchScorer }
export type { LLMJudgeConfig, JudgeCriterion, JudgeRubric, DeterministicScorerConfig, CompositeScorerConfig }

// Criteria
export { STANDARD_CRITERIA, CODE_CRITERIA, CLEAR_CRITERIA, FIVE_POINT_RUBRIC, TEN_POINT_RUBRIC }

// Dataset
export { EvalDataset }
export type { EvalEntry, DatasetMetadata }

// Runner
export { EvalRunner, EvalRegressionError }
export type { EvalRunConfig, EvalProgress, EvalComparison, EvalScorerChange }

// Report
export type { EvalReport, EvalReportEntry, EvalAggregates }
export { reportToMarkdown, reportToJSON, reportToAnnotations }

// Benchmarks
export type { Benchmark, BenchmarkResult, BenchmarkBaseline, LeaderboardEntry, RunBenchmarkOptions }
export { runBenchmark, createCodeGenBenchmark, createPerformanceBenchmark }

// Stores
export { InMemoryEvalResultStore }
```

### 7.2 `@dzipagent/testing`

**Purpose:** Test utilities for deterministic, offline agent testing.

**Dependencies:**
- `@dzipagent/core` (direct) -- for event bus, model registry, stores
- `@dzipagent/agent` (peer, optional) -- for `DzipAgent` in test harness
- `@langchain/core` (peer) -- for `BaseChatModel`, message types

**Exports (public API):**
```typescript
// Mock model
export { MockChatModel }
export type { MockResponse, ResponseRule, ErrorSimulation, MockChatModelConfig, MockCallLogEntry }

// LLM Recorder
export { LLMRecorder }
export type { RecorderConfig, RecorderMode }

// Cassette
export type { CassetteFixture, CassetteMessage, CassetteResponse }
export { loadCassette, saveCassette }

// Test helpers
export { createTestEventBus, createTestRunStore, createTestAgentStore, createTestAgent, createTestConfig, waitForEvent }

// Harness
export { createTestDzipAgent, TestMCPServer, ScenarioRunner }
export type { TestDzipAgentConfig, TestDzipAgentResult, TestMCPTool }
export type { Scenario, ScenarioStep, ScenarioResult, StepResult }

// Assertions
export { expectToolCall, expectMemoryWrite, expectEvent, expectNoErrors, expectMCPToolCall }
```

### 7.3 Relationship to Existing Packages

```
@dzipagent/core          -- no changes needed; provides types and utilities consumed by evals/testing
@dzipagent/agent         -- peer dep of testing (for TestDzipAgent); unchanged
@dzipagent/codegen       -- owns CodeQualityScorer bridge (optional, adapts QualityScorer to Scorer<>)
@dzipagent/server        -- future: PostgresEvalResultStore implementation
```

---

## 8. Migration from Current State

### 8.1 Breaking Changes

There are **no breaking changes** to the existing public API. The current `Scorer`, `EvalInput`, `EvalResult` types remain exported as-is. New types (`Score`, `ScorerConfig`, `ScorerResult`) are additive.

### 8.2 Migration Steps

**Step 1: Rename package** (if needed)

The existing package `@dzipagent/test-utils` should be renamed to `@dzipagent/testing` for consistency with the ecosystem plan naming. This is a breaking change for import paths but not for functionality.

```bash
# In package.json of consumers:
# OLD: "@dzipagent/test-utils": "..."
# NEW: "@dzipagent/testing": "..."
```

**Step 2: Fix ESM violation in LLMRecorder**

Replace `require('node:fs')` in `listFixtures()` with dynamic `import()`.

**Step 3: Enhance types incrementally**

- Add `Score`, `ScorerConfig`, `ScorerResult` to `types.ts`
- Keep old `Scorer` interface as deprecated alias
- Add `toLegacyResult()` helper that converts `ScorerResult` to `EvalResult`

**Step 4: Enhance existing scorers**

- Update `createDeterministicScorer`, `createLLMJudge`, `createCompositeScorer` to produce `ScorerResult`
- Existing usage via the old `evaluate()` return type still works via backward-compatible overloads

**Step 5: Add new features incrementally**

Each feature (F1-F10) can be merged independently. The implementation order follows the dependency chain:

```
F1 (Scorer interface) --> F2 (LLM Judge) --> F3 (Deterministic) --> F4 (Dataset) --> F5 (Runner)
                                                                                       |
F6 (Recorder) --> F7 (Mock Models) --> F8 (Harness) -----> F9 (Benchmarks) --> F10 (CI/CD)
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

Every feature ships with unit tests. Target: 100% coverage for scorers, dataset, runner, mock model, and cassette format.

| Module | Test Focus | Approach |
|--------|-----------|----------|
| Scorers (deterministic) | Score computation, threshold, clamping | Direct function calls with known inputs |
| Scorers (LLM judge) | Prompt construction, JSON parsing, error handling | MockChatModel as judge model |
| Scorers (composite) | Weight calculation, aggregation | Compose deterministic scorers |
| Dataset | Loading from JSON/JSONL/CSV, filtering, sampling | Fixture files in `__tests__/fixtures/` |
| Runner | Batch eval, concurrency, regression detection | Deterministic scorers + inline datasets |
| Report | Markdown/JSON formatting, annotations | Snapshot tests |
| MockChatModel | Sequential, pattern-matched, error sim, call tracking | Direct assertions |
| LLMRecorder | Record/replay/auto modes, cassette IO | Temp directories, MockChatModel as "real" model |
| Cassette | JSONL read/write, fixture lookup | Temp files |
| Assertions | expectToolCall, expectEvent, etc. | Constructed event arrays |
| Scenario runner | Multi-step execution, assertion collection | createTestDzipAgent + mock model |

### 9.2 Integration Tests

Integration tests validate the full eval pipeline end-to-end:

1. **Record-and-replay round-trip:** Record an agent interaction, replay it, verify identical outputs.
2. **CI mode exit codes:** Run evaluations with intentional regressions, verify `EvalRegressionError` is thrown.
3. **Report generation:** Run a full eval, verify markdown report is well-formed.
4. **Benchmark execution:** Run the code-gen benchmark with mock models, verify report structure.

### 9.3 Boundary Tests

Verify package isolation:

```typescript
// __tests__/boundaries.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Package boundaries', () => {
  it('@dzipagent/evals does not import from @dzipagent/agent', () => {
    // Scan all source files in forgeagent-evals for agent imports
    // This test enforces the dependency graph
  })

  it('@dzipagent/evals does not import from @dzipagent/codegen', () => {
    // Same check for codegen imports
  })

  it('@dzipagent/testing does not import from @dzipagent/codegen', () => {
    // Same check for codegen imports
  })
})
```

---

## 10. Effort Summary

| Feature | ID | Priority | Hours | Package | Dependencies |
|---------|----|----------|-------|---------|--------------|
| Scorer Interface | F1 | P1 | 4h | evals | None |
| LLM-as-Judge Scorer | F2 | P1 | 8h | evals | F1 |
| Deterministic Scorers | F3 | P1 | 4h | evals | F1 |
| Eval Dataset | F4 | P1 | 4h | evals | F1 |
| Eval Runner | F5 | P1 | 8h | evals | F1, F4 |
| LLM Recorder | F6 | P1 | 8h | testing | None |
| Mock Models | F7 | P1 | 4h | testing | None |
| Integration Test Harness | F8 | P1 | 8h | testing | F6, F7 |
| Benchmark Suite | F9 | P2 | 8h | evals | F1-F5 |
| CI/CD Integration | F10 | P1 | 4h | evals | F5 |
| **Total** | | | **60h** | | |

**Note:** 8h buffer (68h total) accounts for test writing, documentation, and integration debugging.

### Implementation Order (recommended)

```
Week 1: Foundation
  F1 (Scorer Interface)     -- 4h, unblocks everything
  F6 (LLM Recorder)         -- 8h, independent track
  F7 (Mock Models)           -- 4h, independent track

Week 2: Scorers + Dataset
  F2 (LLM Judge)            -- 8h, needs F1
  F3 (Deterministic)        -- 4h, needs F1
  F4 (Eval Dataset)         -- 4h, needs F1

Week 3: Runner + Harness
  F5 (Eval Runner)          -- 8h, needs F1+F4
  F8 (Integration Harness)  -- 8h, needs F6+F7

Week 4: CI + Benchmarks
  F10 (CI/CD)               -- 4h, needs F5
  F9 (Benchmarks)           -- 8h, needs F1-F5
```

---

## ADR-008: Evaluation and Testing Framework Architecture

### Status: Proposed

### Context
DzipAgent has code-quality scoring (`QualityScorer` in codegen) but no framework for evaluating agent responses, no deterministic testing infrastructure, and no CI/CD integration for quality gates. The existing `@dzipagent/evals` and `@dzipagent/test-utils` packages have basic implementations that need enhancement.

### Decision
Split evaluation and testing into two packages:
- `@dzipagent/evals` -- scorer abstractions, datasets, runner, reporting, benchmarks
- `@dzipagent/testing` -- mock models, LLM recorder, integration harness, assertion helpers

The `Scorer<TInput>` interface is generic to support both agent response evaluation and code quality scoring. The codegen `QualityScorer` can be adapted to the evals `Scorer` interface via a bridge in the codegen package, but neither package depends on the other.

### Constraints
- `@dzipagent/evals` must not import from `@dzipagent/agent` or `@dzipagent/codegen`
- `@dzipagent/testing` must not import from `@dzipagent/codegen`
- All LLM calls in tests must be interceptable via `LLMRecorder` or `MockChatModel`
- CI mode must produce non-zero exit codes on regression
- All new types must be TypeScript strict compatible (no `any`)

### Consequences

**Positive:**
- Deterministic CI/CD: tests run without LLM calls using recorded fixtures
- Regression detection: baseline comparison catches quality drops before merge
- Composable evaluation: mix LLM judges and deterministic scorers freely
- Standard benchmarks: compare agent configurations on a level playing field

**Negative:**
- Two new packages to maintain
- LLM judge scorers incur cost (mitigated by using cheap models like Haiku)
- Cassette fixtures require periodic re-recording as prompts change

**Risks:**
- Cassette drift: recorded fixtures become stale as system prompts evolve. Mitigated by `auto` mode that re-records missing fixtures.
- Judge reliability: LLM judges can be inconsistent. Mitigated by retries, structured rubrics, and multi-criteria averaging.

### Alternatives Considered
1. **Single `@dzipagent/evals` package for everything** -- rejected because testing utilities (mocks, recorder) are needed by all packages, not just eval consumers.
2. **Use Vitest mocks instead of MockChatModel** -- rejected because `vi.fn()` does not provide LangChain-compatible `BaseChatModel` instances with proper `_generate()` contract.
3. **External eval service (Langfuse, Braintrust)** -- not rejected but complementary. The built-in framework handles offline/CI evaluation; external services handle production monitoring.
