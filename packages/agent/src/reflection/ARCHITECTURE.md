# Reflection Module Architecture (`packages/agent/src/reflection`)

## 1. Scope and Responsibility

This folder currently contains one production module:

- `run-reflector.ts`

`RunReflector` is a run-quality scoring component for agent executions. It produces a normalized score in `[0,1]` with per-dimension diagnostics and flags.

Primary goals:

- Provide fast heuristic scoring on every run.
- Optionally augment low-confidence or all runs with LLM reflection.
- Return structured data usable by observability, routing feedback loops, and model-tier escalation.

## 2. Public API Surface

### Exported Types

- `ReflectionDimensions`
  - `completeness`
  - `coherence`
  - `toolSuccess`
  - `conciseness`
  - `reliability`
- `ReflectorConfig`
  - `llm?: (prompt: string) => Promise<string>`
  - `llmMode?: 'always' | 'on-low-score'`
  - `llmThreshold?: number`
- `ReflectionScore`
  - `overall: number`
  - `dimensions: ReflectionDimensions`
  - `flags: string[]`
- `ReflectionInput`
  - `input`, `output`
  - optional `toolCalls`
  - optional `tokenUsage`
  - `durationMs`
  - optional `errorCount`, `retryCount`

### Exported Class

- `RunReflector`
  - `async score(input: ReflectionInput): Promise<ReflectionScore>`
  - `scoreHeuristic(input: ReflectionInput): ReflectionScore`

## 3. Scoring Model

### 3.1 Dimension Weights

Heuristic overall score is weighted:

- `completeness`: `0.3`
- `coherence`: `0.2`
- `toolSuccess`: `0.2`
- `conciseness`: `0.1`
- `reliability`: `0.2`

Weights sum to `1.0`.

### 3.2 Heuristic Dimension Behavior

- `completeness`
  - Empty/null/undefined output => `0`, flag `empty_output`
  - Very short output (`<5 chars`) with non-trivial input (`>20 chars`) => `0.2`, flag `very_short_output`
  - Otherwise `1.0`
- `coherence`
  - Empty output => `0`
  - Truncation markers (`...`, `[truncated]`, `[cut off]`, HTML truncation marker) => `-0.3`, flag `truncated_output`
  - Error-like text (`internal server error`, `unhandled exception`, `stack trace`) => `-0.2`, flag `error_in_output`
  - JSON parseability is treated as non-negative (no extra score, no penalty)
- `toolSuccess`
  - No tools / empty tools => `1.0`
  - Otherwise ratio `successes / total`
  - If all fail => flag `all_tools_failed`
- `conciseness`
  - Empty output => `1.0` (handled by completeness)
  - Output `>10_000 chars` => gradual penalty, flag `very_long_output`
  - High output/input ratio for non-trivial input (`>10 chars`) with threshold ratio `20` => gentle penalty
  - Otherwise `1.0`
- `reliability`
  - Formula: `1 - (errorCount * 0.2 + retryCount * 0.1)`, clamped to `[0,1]`
  - `retryCount >= 3` => flag `excessive_retries`

### 3.3 Informational Flags

- `durationMs < 500` => flag `very_fast` (does not directly lower score)

### 3.4 LLM-Enhanced Mode

If `config.llm` is present:

- `llmMode: 'always'` => invoke LLM every run
- `llmMode: 'on-low-score'` (default) => invoke only when heuristic `overall < llmThreshold`
- default `llmThreshold = 0.6`

LLM output schema expected in JSON:

```json
{ "completeness": 0.0, "coherence": 0.0, "relevance": 0.0, "reasoning": "..." }
```

Merge strategy:

- Replace heuristic `completeness` and `coherence` with LLM values.
- Keep heuristic `toolSuccess`, `conciseness`, `reliability`.
- Compute `llmOverall = average(completeness, coherence, relevance)`.
- Blend final overall: `0.6 * llmOverall + 0.4 * heuristicOverall`.
- Append `llm_enhanced` flag.

Failure behavior:

- Any LLM error/parse failure falls back to heuristic result.
- Append `llm_reflection_failed` flag.

## 4. End-to-End Flow

```text
ReflectionInput
  -> scoreHeuristic()
    -> stringify input/output
    -> score completeness/coherence/toolSuccess/conciseness/reliability
    -> build flags + weighted overall
  -> if no llm: return heuristic result
  -> else decide invocation (mode + threshold)
    -> if not invoked: return heuristic result
    -> if invoked:
       -> build LLM prompt from run data
       -> parse JSON response
       -> merge LLM + heuristic scores
       -> return enhanced score
       -> on failure: return heuristic + llm_reflection_failed
```

## 5. Feature Inventory

1. Stateless scoring engine
- Each call is independent and side-effect free.

2. Defensive input handling
- Accepts string/object/null outputs and normalizes via internal `stringify()`.

3. Explainability via flags
- Flags capture notable quality/runtime patterns for downstream operators.

4. Optional low-cost LLM augmentation
- Heuristic mode can run with zero LLM overhead.
- Threshold mode limits LLM costs to suspicious runs.

5. Robust LLM response parsing
- Extracts first JSON object from raw text.
- Validates numeric dimensions and clamps to `[0,1]`.

6. Public sync heuristic API
- `scoreHeuristic()` allows deterministic synchronous usage where async calls are not desired.

## 6. Usage Examples

### 6.1 Heuristic-Only (default)

```ts
import { RunReflector } from '@dzupagent/agent'

const reflector = new RunReflector()

const score = await reflector.score({
  input: 'Summarize Q1 report',
  output: 'Revenue grew 15% YoY...',
  durationMs: 1800,
  toolCalls: [{ name: 'readFile', success: true, durationMs: 95 }],
  errorCount: 0,
  retryCount: 0,
})
```

### 6.2 LLM on Low Scores

```ts
import { RunReflector } from '@dzupagent/agent'

const reflector = new RunReflector({
  llm: async (prompt) => myModel.generate(prompt),
  llmMode: 'on-low-score',
  llmThreshold: 0.6,
})
```

### 6.3 LLM Always

```ts
const reflector = new RunReflector({
  llm: async (prompt) => myModel.generate(prompt),
  llmMode: 'always',
})
```

### 6.4 Sync Integration (server `RunReflectorLike` compatibility)

`packages/server` currently defines `RunReflectorLike.score()` as synchronous. For safe compatibility without async bridging, use heuristic-only sync scoring:

```ts
import { RunReflector } from '@dzupagent/agent'

const rr = new RunReflector()

const reflectorLike = {
  score(input) {
    return rr.scoreHeuristic(input)
  },
}
```

## 7. Cross-Package References and Runtime Usage

## 7.1 Public export from `@dzupagent/agent`

- `packages/agent/src/index.ts`
  - exports `RunReflector`, `ReflectionInput`, `ReflectionScore`, `ReflectorConfig`

## 7.2 Server runtime contract and ingestion

- `packages/server/src/runtime/run-worker.ts`
  - defines structural reflection types (`ReflectionInput`, `ReflectionScore`, `RunReflectorLike`)
  - builds `reflectionInput` from run context/logs
  - stores `reflectionScore` in run metadata
  - emits reflection log entry with overall/dimensions/flags

## 7.3 Retrieval quality feedback loop

- `packages/server/src/runtime/retrieval-feedback-hook.ts`
  - consumes `reflectionScore.overall`
  - maps score to `good|mixed|bad`
  - reports feedback to retrieval sink

## 7.4 Model tier escalation loop

- `packages/server/src/runtime/run-worker.ts`
  - passes `reflectionScore.overall` to escalation policy
- `packages/core/src/router/escalation-policy.ts`
  - interprets low-score streaks to recommend tier escalation

## 7.5 Routing observability

- `packages/server/src/routes/routing-stats.ts`
  - aggregates `metadata.reflectionScore.overall`
  - reports average quality + low-quality count

## 8. Test Coverage (Descriptive)

Validated locally:

```bash
yarn workspace @dzupagent/agent test src/__tests__/run-reflector.test.ts src/__tests__/run-reflector-llm.test.ts
```

Result:

- `2` test files passed
- `61` tests passed

### 8.1 `run-reflector.test.ts` (40 tests)

Covers heuristic behavior comprehensively:

- perfect-run baseline
- completeness edge cases (empty/null/undefined/short output)
- coherence checks (truncation/error markers/JSON path)
- tool success ratio and all-failed flag
- conciseness penalties (length and ratio)
- reliability penalties and retry flags
- `very_fast` and multi-flag accumulation
- overall weighted formula and clamping
- object/numeric/zero-duration and optional field edge cases

### 8.2 `run-reflector-llm.test.ts` (21 tests)

Covers LLM path and fallback behavior:

- backward compatibility with no config/empty config
- `always` vs default `on-low-score` invocation logic
- threshold behavior (default and custom)
- score merge semantics and blend formula
- heuristic-flag preservation after enhancement
- fallback when LLM throws or returns invalid payload
- prompt content checks (input/output/tool calls/no tools)
- public `scoreHeuristic()` availability
- LLM dimension clamping

### 8.3 Cross-package behavioral tests involving reflection score usage

- `packages/server/src/__tests__/escalation-wiring.test.ts`
  - verifies score-driven escalation wiring and logging behavior
- `packages/server/src/__tests__/retrieval-feedback-hook.test.ts`
  - verifies score-to-quality mapping and reporting behavior

## 9. Design Notes and Constraints

1. `tokenUsage` is accepted in `ReflectionInput` but not currently used in scoring formulas.
2. LLM prompt includes raw input/output text; callers should avoid passing sensitive payloads unless model policy permits.
3. Server-side structural contract (`RunReflectorLike`) is currently synchronous; async LLM reflection requires an adapter approach or server contract evolution.

