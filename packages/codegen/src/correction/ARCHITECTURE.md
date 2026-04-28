# Correction Module Architecture (`packages/codegen/src/correction`)

## Scope

This document covers the correction subsystem implemented in:

- `packages/codegen/src/correction/correction-types.ts`
- `packages/codegen/src/correction/self-correction-loop.ts`
- `packages/codegen/src/correction/reflection-node.ts`
- `packages/codegen/src/correction/lesson-extractor.ts`
- `packages/codegen/src/correction/index.ts`

It also references package-level exports and tests inside `packages/codegen` that exercise this subsystem.

## Responsibilities

The correction subsystem provides an interface-driven, iterative fix loop over a VFS snapshot (`Record<string, string>`):

1. Run injected evaluation logic (`CodeEvaluator`) against generated code.
2. Build structured diagnosis (`Reflection`) either from an LLM (`ReflectionNode`) or a heuristic fallback.
3. Apply injected fix logic (`CodeFixer`) and track changed files and token usage.
4. Repeat under explicit termination guards (`maxIterations`, `maxCostCents`, acceptance criteria).
5. Optionally extract reusable lessons (`LessonExtractor`) from successful correction history.
6. Emit lifecycle events through callbacks (`onIteration`, `onFixed`, `onExhausted`).

The module does not run lint/tests/typecheck itself and does not persist lessons; both are delegated to integrators.

## Structure

| File | Role | Main exports |
| --- | --- | --- |
| `correction-types.ts` | Shared contracts/config/event payloads | `ErrorCategory`, `EvaluationResult`, `Reflection`, `CorrectionIteration`, `CorrectionResult`, `CorrectionContext`, `Lesson`, `CodeEvaluator`, `CodeFixer`, `SelfCorrectionConfig`, `DEFAULT_CORRECTION_CONFIG`, `CorrectionIterationEvent`, `CorrectionFixedEvent`, `CorrectionExhaustedEvent` |
| `self-correction-loop.ts` | Loop orchestrator and stop conditions | `SelfCorrectionLoop`, `CorrectionEventListeners`, `SelfCorrectionDeps` |
| `reflection-node.ts` | Structured LLM reflection + parsing fallback | `ReflectionNode`, `ReflectionSchema`, `ReflectionNodeConfig`, `ReflectionResult` |
| `lesson-extractor.ts` | Lesson extraction (LLM or heuristics) | `LessonExtractor`, `LessonExtractorConfig`, `LessonExtractionResult` |
| `index.ts` | Submodule barrel | Re-exports all correction types/classes |

Top-level exposure:

- `packages/codegen/src/index.ts` re-exports the complete correction API block under the package root (`@dzupagent/codegen`).

## Runtime and Control Flow

`SelfCorrectionLoop.run(generatedCode, context)` flow:

1. Initialize `currentVfs`, `iterations`, `totalTokens`, `totalCostCents`, and start timer.
2. For `i = 0 .. maxIterations - 1`:
   - Evaluate via `evaluator.evaluate(currentVfs, context)`.
   - If acceptable (`passed`, quality above threshold, and no lint errors):
     - Record success iteration with `reflection = null`.
     - Optionally extract lessons via `lessonExtractor.extract(...)`.
     - Emit `onFixed` and return `CorrectionResult` with `wasFixed = true`.
   - Build reflection:
     - Preferred: `reflectionNode.reflect(currentVfs, evaluation)` when enabled and provided.
     - Fallback: `buildFallbackReflection(evaluation)` classification from error text.
   - Enforce pre-fix cost guard (`totalCostCents >= maxCostCents` breaks loop).
   - Apply fix via `fixer.fix(currentVfs, reflection, context)` and update `currentVfs`.
   - Record iteration and emit `onIteration`.
   - Enforce post-fix cost guard.
3. After loop exits without early success:
   - If last iteration modified files, run one final evaluation pass.
   - If final pass is acceptable, emit `onFixed` and return success.
4. Otherwise emit `onExhausted` and return failure result.

Behavioral details from implementation:

- Cost estimate uses `estimateCost(tokens) = ((inputTokens + outputTokens) / 1000) * 0.3` (cents).
- `LessonExtractor.extract(...)` token usage is currently not merged into `CorrectionResult.totalTokens` or `totalCostCents`.
- Fallback reflection categories are inferred from regex patterns over lint/test error text.

## Key APIs and Types

Core loop APIs:

- `new SelfCorrectionLoop(deps, config?)`
- `loop.run(generatedCode, context?) => Promise<CorrectionResult>`
- `SelfCorrectionDeps`: `{ evaluator, fixer, reflectionNode?, lessonExtractor?, listeners? }`

Correction contracts:

- `CodeEvaluator.evaluate(vfs, context?) => Promise<EvaluationResult>`
- `CodeFixer.fix(vfs, reflection, context?) => Promise<{ vfs; filesModified; tokensUsed }>`

Reflection:

- `new ReflectionNode({ registry, modelTier?, systemPrompt? })`
- `reflect(vfs, evaluation) => Promise<{ reflection; tokensUsed }>`
- `ReflectionSchema` (Zod): validates `rootCause`, `affectedFiles`, `suggestedFix`, `confidence`, `category`, optional `additionalContext`.

Lesson extraction:

- `new LessonExtractor({ registry?, modelTier? })`
- `extract(iterations, context?) => Promise<{ lessons; tokensUsed }>`
- LLM mode runs when `registry` exists; otherwise heuristic templates per `ErrorCategory`.

Defaults:

- `DEFAULT_CORRECTION_CONFIG`:
  - `maxIterations: 3`
  - `maxCostCents: 50`
  - `qualityThreshold: 70`
  - `enableReflection: true`
  - `enableLessonExtraction: true`

## Dependencies

Direct code dependencies used by this module:

- `@dzupagent/core`
  - `TokenUsage` type in loop/types/extractor.
  - `ModelRegistry`, `ModelTier`, and `extractTokenUsage` for LLM nodes.
- `@langchain/core/messages`
  - `SystemMessage`, `HumanMessage` for LLM prompts in `ReflectionNode` and `LessonExtractor`.
- `zod`
  - Runtime schema validation for `ReflectionSchema`.

Package-level context from `packages/codegen/package.json`:

- Runtime deps include `@dzupagent/core` and `@dzupagent/adapter-types`.
- `@langchain/core`, `@langchain/langgraph`, and `zod` are peer dependencies (with local dev dependencies for tests/builds).

## Integration Points

Within `@dzupagent/codegen`:

1. Export surface:
   - Correction classes/types are re-exported from `packages/codegen/src/index.ts`.
2. Quality coupling by contract:
   - Correction acceptance depends on `EvaluationResult.qualityScore` and `qualityThreshold`, but correction does not directly import quality scorer modules.
3. VFS coupling by data shape:
   - Inputs/outputs are plain VFS snapshots (`Record<string, string>`), not tied to `VirtualFS` class internals.

Cross-package usage in current repository scan:

- No non-test package files outside `packages/codegen` currently import `SelfCorrectionLoop`, `ReflectionNode`, or `LessonExtractor` directly.
- This makes the subsystem presently a reusable exported primitive with test-backed behavior, rather than a wired production runtime path in this repo snapshot.

## Testing and Observability

Primary test suites in `packages/codegen/src/__tests__`:

- `self-correction-loop.test.ts`
- `self-correction-loop-extended.test.ts`
- `lesson-extractor-and-reflection.test.ts`

Coverage focus in tests includes:

1. Success paths and multi-iteration correction paths.
2. Max-iteration and max-cost termination behavior.
3. Acceptance criteria edge cases (`passed`, lint errors, quality threshold).
4. Fallback reflection classification and file-path extraction.
5. ReflectionNode parsing for valid JSON and malformed model output.
6. LessonExtractor heuristic mode, LLM mode, and fallback behavior.
7. Event callbacks payloads (`onIteration`, `onFixed`, `onExhausted`).
8. VFS immutability and cumulative mutation behavior across iterations.

Observability in implementation:

- Callback-only event hooks (no built-in event bus wiring in this module):
  - `onIteration(event)`
  - `onFixed(event)`
  - `onExhausted(event)`
- Per-iteration and total duration metrics (`durationMs`, `totalDurationMs`) are included in result/event payloads.

## Risks and TODOs

1. Cost-model accuracy:
   - `estimateCost` is a fixed blended approximation and does not model provider/model-specific pricing.
2. Incomplete token accounting:
   - Lesson extraction token usage is returned by `LessonExtractor` but not folded into `CorrectionResult.totalTokens`/`totalCostCents`.
3. Reflection fallback brittleness:
   - Regex-based fallback parsing can misclassify categories or extract noisy file paths from unstructured model output.
4. Prompt budget pressure:
   - `ReflectionNode` may include up to 30 files with up to 3000 chars each, which can still be expensive for large VFS states.
5. Current integration depth:
   - No direct non-test consumers in this repository currently wire correction runtime classes, so drift risk between exported API and real production usage exists.
6. Version constant drift outside this folder:
   - `packages/codegen/src/index.ts` exports `dzupagent_CODEGEN_VERSION = '0.2.0'`, matching the package version for runtime/version reporting.

## Changelog

- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
