# Correction Module Architecture (`packages/codegen/src/correction`)

## Overview

This folder implements a self-correction subsystem for generated code in `@dzupagent/codegen`.

It provides:

1. An iterative correction orchestrator (`SelfCorrectionLoop`)
2. Optional LLM-based diagnosis (`ReflectionNode`)
3. Reusable lesson extraction (`LessonExtractor`)
4. A typed contract surface for dependency injection and eventing (`correction-types.ts`)

Core loop shape:

`Evaluate -> Diagnose/Reflect -> Revise -> Verify`

The module is intentionally interface-driven so you can plug in your own evaluator/fixer and run it in different environments (local, CI, sandbox, mocked tests).

## Design Goals

1. Keep correction logic decoupled from concrete test/lint/sandbox implementations.
2. Preserve full iteration history for observability and post-run learning.
3. Support both LLM-enabled and heuristic-only execution modes.
4. Enforce bounded execution with iteration and cost guards.
5. Return structured lessons that can be persisted by higher-level memory systems.

## Module Inventory

| File | Responsibility | Key Exports |
|---|---|---|
| `correction-types.ts` | Shared contracts and config defaults | `ErrorCategory`, `EvaluationResult`, `Reflection`, `CorrectionResult`, `CodeEvaluator`, `CodeFixer`, `DEFAULT_CORRECTION_CONFIG` |
| `self-correction-loop.ts` | Orchestration engine for iterative fix cycles | `SelfCorrectionLoop`, `CorrectionEventListeners`, `SelfCorrectionDeps` |
| `reflection-node.ts` | Structured LLM critique and root-cause diagnosis | `ReflectionNode`, `ReflectionSchema`, `ReflectionNodeConfig` |
| `lesson-extractor.ts` | Post-fix lesson extraction (LLM or heuristic) | `LessonExtractor`, `LessonExtractorConfig` |
| `index.ts` | Local barrel for this folder | Re-exports all correction APIs |

Top-level package re-export:

- `packages/codegen/src/index.ts` re-exports the full correction API surface.

## Data Model

Primary types are defined in `correction-types.ts`:

- `ErrorCategory`: canonical issue taxonomy (`syntax_error`, `type_error`, `logic_error`, `missing_import`, `api_misuse`, `test_failure`, `lint_violation`, `runtime_error`)
- `EvaluationResult`: output from evaluator (pass/fail, lint/test details, quality score, optional raw output)
- `Reflection`: structured diagnosis used by fixer
- `CorrectionIteration`: per-iteration audit record (evaluation, reflection, VFS snapshot, file edits, token usage, duration)
- `CorrectionResult`: final run result (final code, history, aggregate tokens/cost, fixed/not-fixed, lessons)
- `CorrectionContext`: optional plan/tech-stack/prior-lessons/system-prompt hints
- `Lesson`: reusable rule extracted from successful fixes

Dependency inversion contracts:

- `CodeEvaluator.evaluate(vfs, context) -> EvaluationResult`
- `CodeFixer.fix(vfs, reflection, context) -> { vfs, filesModified, tokensUsed }`

## Runtime Flow

High-level sequence inside `SelfCorrectionLoop.run(...)`:

1. Initialize loop state (`currentVfs`, `iterations`, token/cost counters).
2. For up to `maxIterations`:
   1. Evaluate current VFS.
   2. If acceptable, emit iteration + fixed event, optionally extract lessons, return success.
   3. Build reflection:
      - LLM reflection via `ReflectionNode.reflect(...)` when enabled and provided.
      - Heuristic fallback reflection otherwise.
   4. Enforce pre-fix cost guard.
   5. Apply fix via injected `CodeFixer`.
   6. Record iteration, emit iteration event.
   7. Enforce post-fix cost guard.
3. If loop exits without success, run one final verification pass if last iteration modified files.
4. If still not acceptable, emit exhausted event and return failure.

Acceptance criteria (`isAcceptable`):

- `evaluation.passed === true`
- `evaluation.qualityScore >= qualityThreshold`
- `evaluation.lintErrors.length === 0`

### Fallback Behavior

When no LLM reflection is available:

- `buildFallbackReflection(...)` classifies category by regex over lint/test errors.
- File paths are extracted from error text.
- Confidence defaults to `0.5`.

This enables deterministic correction runs in test or offline environments.

## Component Details

## 1) `SelfCorrectionLoop`

Main features:

1. Iterative fix orchestration with configurable guards
2. Full iteration history retention
3. Optional reflection and lesson extraction stages
4. Event callbacks (`onIteration`, `onFixed`, `onExhausted`)
5. Final verification pass after loop exhaustion (when a fix was attempted)

Token/cost accounting:

- Aggregates tokens from reflection + fixer calls.
- Uses `estimateCost(...)` with a rough blended estimate (`$0.003 / 1K tokens` => `0.3` cents per `1K`).
- Aborts when `totalCostCents >= maxCostCents`.

Current behavior note:

- `LessonExtractor.extract(...)` token usage is not currently added to `CorrectionResult.totalTokens` or `totalCostCents`; only returned lessons are used.

## 2) `ReflectionNode`

Main features:

1. Zod-validated structured diagnosis schema (`ReflectionSchema`).
2. Prompt composition with:
   - lint/type errors
   - test failures/errors
   - quality score
   - optional raw output (truncated)
   - source file snippets (up to 30 files, 3000 chars/file)
3. Robust response parsing:
   - primary path: parse JSON and validate
   - fallback path: regex-based extraction and category guessing
4. Token extraction via `extractTokenUsage(...)`.

Why this matters:

- Downstream fixer receives stable structured fields even when model output is noisy.
- Fallback parsing keeps the loop functional under malformed model responses.

## 3) `LessonExtractor`

Main features:

1. Two operating modes:
   - LLM mode: if `registry` provided, generate contextual lessons.
   - Heuristic mode: category-template rules without LLM dependency.
2. Frequency tracking by error category.
3. Category normalization for model outputs.
4. Safe fallback to heuristics on JSON/parse failures.

Heuristic templates include rules for all `ErrorCategory` values, ensuring minimal lesson coverage even without model access.

## Configuration

`DEFAULT_CORRECTION_CONFIG`:

- `maxIterations: 3`
- `maxCostCents: 50`
- `qualityThreshold: 70`
- `enableReflection: true`
- `enableLessonExtraction: true`

Per-run context (`CorrectionContext`) can carry plan/stack metadata and prompt overrides.

## Usage Examples

## 1) Minimal (heuristic reflection, no LLM)

```ts
import { SelfCorrectionLoop, type CodeEvaluator, type CodeFixer } from '@dzupagent/codegen'

const evaluator: CodeEvaluator = {
  async evaluate(vfs) {
    return {
      passed: false,
      lintErrors: ['Cannot find module "./x"'],
      qualityScore: 40,
      testResults: { passed: 0, failed: 1, errors: ['suite failed'], failedTests: [] },
    }
  },
}

const fixer: CodeFixer = {
  async fix(vfs, reflection) {
    const next = { ...vfs }
    // apply deterministic fix based on reflection
    return { vfs: next, filesModified: ['src/app.ts'], tokensUsed: { model: '', inputTokens: 0, outputTokens: 0 } }
  },
}

const loop = new SelfCorrectionLoop(
  { evaluator, fixer },
  { enableReflection: false, qualityThreshold: 70, maxIterations: 3 },
)

const result = await loop.run({ 'src/app.ts': '/* generated */' })
```

## 2) Full LLM-assisted correction

```ts
import {
  SelfCorrectionLoop,
  ReflectionNode,
  LessonExtractor,
  type CodeEvaluator,
  type CodeFixer,
} from '@dzupagent/codegen'

const reflectionNode = new ReflectionNode({ registry: modelRegistry, modelTier: 'codegen' })
const lessonExtractor = new LessonExtractor({ registry: modelRegistry, modelTier: 'chat' })

const loop = new SelfCorrectionLoop(
  { evaluator, fixer, reflectionNode, lessonExtractor },
  { maxIterations: 5, maxCostCents: 100, qualityThreshold: 75 },
)

const result = await loop.run(initialVfs, {
  techStack: { language: 'typescript', framework: 'express' },
  priorLessons: persistedLessons,
})
```

## 3) Event-driven observability

```ts
const loop = new SelfCorrectionLoop({
  evaluator,
  fixer,
  listeners: {
    onIteration: (e) => logger.info({ e }, 'correction iteration'),
    onFixed: (e) => logger.info({ e }, 'correction fixed'),
    onExhausted: (e) => logger.warn({ e }, 'correction exhausted'),
  },
})
```

## Use Cases

1. Post-generation validation/fix pipeline in agentic codegen workflows.
2. CI auto-remediation loops for lint/type/test regressions.
3. Structured root-cause analysis before creating follow-up fix prompts.
4. Building a memory of recurring failure patterns via extracted lessons.
5. Running deterministic correction in constrained environments (heuristic-only mode).

## References In Other Packages

Direct findings across the monorepo:

1. Export surface availability:
   - `packages/codegen/src/index.ts` re-exports all correction APIs.
2. Runtime import of `@dzupagent/codegen` in server package:
   - `packages/server/src/runtime/tool-resolver.ts` dynamically imports `@dzupagent/codegen` for git tool resolution (not correction classes directly).
3. Project template dependency:
   - `packages/create-dzupagent/src/templates/codegen.ts` includes `@dzupagent/codegen` in scaffolded dependencies.
4. Evals package dynamic import:
   - `packages/evals/src/__tests__/sandbox-contracts.test.ts` dynamically imports `@dzupagent/codegen` for sandbox contract tests.
5. Documentation cross-reference:
   - `packages/core/src/llm/ARCHITECTURE.md` references `reflection-node.ts` and `lesson-extractor.ts`.

Important note:

- No direct runtime imports of `SelfCorrectionLoop`, `ReflectionNode`, or `LessonExtractor` were found outside `packages/codegen` tests at the time of this analysis.

## Test Coverage

Validated test suites for this module:

- `src/__tests__/self-correction-loop.test.ts` (`23` tests)
- `src/__tests__/self-correction-loop-extended.test.ts` (`29` tests)
- `src/__tests__/lesson-extractor-and-reflection.test.ts` (`39` tests)

Total executed correction tests: `91` (all passing).

Executed commands:

```bash
cd packages/codegen && yarn test src/__tests__/self-correction-loop.test.ts src/__tests__/self-correction-loop-extended.test.ts src/__tests__/lesson-extractor-and-reflection.test.ts
cd packages/codegen && yarn vitest run --coverage --coverage.include='src/correction/**/*.ts' src/__tests__/self-correction-loop.test.ts src/__tests__/self-correction-loop-extended.test.ts src/__tests__/lesson-extractor-and-reflection.test.ts
```

Focused coverage (`src/correction/**/*.ts`):

| File | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `correction-types.ts` | 100% | 100% | 100% | 100% |
| `lesson-extractor.ts` | 99.26% | 75% | 100% | 99.26% |
| `reflection-node.ts` | 97.72% | 89.74% | 100% | 97.72% |
| `self-correction-loop.ts` | 98.87% | 96.49% | 100% | 98.87% |
| **All correction files** | **98.95%** | **88.23%** | **100%** | **98.95%** |

Observed remaining uncovered spots from focused report:

- `lesson-extractor.ts`: lines `216-217` (error handling branch in JSON parse fallback)
- `reflection-node.ts`: lines around `158-159`, `183-184` (overflow and JSON parse fallback branches)
- `self-correction-loop.ts`: lines `202-205` (event path in final-verification success branch)

## Risks / Improvement Opportunities

1. Lesson extraction token/cost usage is currently not aggregated into `CorrectionResult`.
2. Reflection prompt can become large for broad VFS snapshots (30 files x 3000 chars); additional prioritization by changed files may improve signal/cost.
3. Cost model is intentionally coarse; model-tier-specific pricing hooks could improve budget accuracy.
4. Lesson persistence is intentionally external; add a first-class persistence adapter if runtime learning is required.

