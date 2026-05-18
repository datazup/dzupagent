# Correction Module Architecture (`packages/codegen/src/correction`)

## Scope
This document describes the self-correction subsystem implemented in the following files.

- `packages/codegen/src/correction/correction-types.ts`
- `packages/codegen/src/correction/self-correction-loop.ts`
- `packages/codegen/src/correction/reflection-node.ts`
- `packages/codegen/src/correction/lesson-extractor.ts`
- `packages/codegen/src/correction/index.ts`

It also references package-level exports in `packages/codegen/src/index.ts`, package metadata in `packages/codegen/package.json`, and correction-specific tests under `packages/codegen/src/__tests__`.

## Responsibilities
The correction subsystem provides an iterative, dependency-injected code-fix loop over VFS snapshots (`Record<string, string>`).

- Evaluate generated code through an injected `CodeEvaluator`.
- Apply acceptance criteria using all three checks: `evaluation.passed === true`, `evaluation.qualityScore >= qualityThreshold`, and `evaluation.lintErrors.length === 0`.
- Generate structured diagnosis (`Reflection`) using `ReflectionNode` when configured, otherwise internal fallback heuristics.
- Apply fixes through an injected `CodeFixer`.
- Track iteration history, token usage, estimated cost, and timing.
- Optionally extract reusable lessons via `LessonExtractor` after successful runs.
- Emit lifecycle callbacks (`onIteration`, `onFixed`, `onExhausted`) for external observability.
- Delegate lint/test/typecheck execution details to `CodeEvaluator`.
- Delegate rewrite strategy to `CodeFixer`.
- Return extracted lessons to the caller without persistence.

## Structure
`correction-types.ts` defines shared contracts and defaults.

- Exports `ErrorCategory`, `EvaluationResult`, `Reflection`, `CorrectionIteration`, `CorrectionResult`, `CorrectionContext`, and `Lesson`.
- Exports integration contracts `CodeEvaluator`, `CodeFixer`, and `SelfCorrectionConfig`.
- Exports lifecycle payloads `CorrectionIterationEvent`, `CorrectionFixedEvent`, and `CorrectionExhaustedEvent`.
- Exports `DEFAULT_CORRECTION_CONFIG`.

`self-correction-loop.ts` implements orchestration.

- Exports `SelfCorrectionLoop`.
- Exports `SelfCorrectionDeps` and `CorrectionEventListeners`.
- Implements token merge helpers, cost estimation (`estimateCost`), and fallback reflection construction (`buildFallbackReflection`).

`reflection-node.ts` implements LLM-backed diagnosis.

- Exports `ReflectionNode`.
- Exports `ReflectionSchema` (Zod), `ReflectionNodeConfig`, and `ReflectionResult`.
- Builds prompt content from evaluation signals and VFS snapshots.
- Parses JSON first, then falls back to text extraction.

`lesson-extractor.ts` implements lesson generation.

- Exports `LessonExtractor`.
- Exports `LessonExtractorConfig` and `LessonExtractionResult`.
- Supports LLM mode (`registry` present) and heuristic mode (category templates).

`index.ts` re-exports the correction surface.

- Re-exports all classes, types, and defaults from the correction module.

Package-level export integration.

- `packages/codegen/src/index.ts` re-exports correction APIs under `@dzupagent/codegen`.

## Runtime and Control Flow
`SelfCorrectionLoop.run(generatedCode, context?)` follows this sequence.

1. Initialize loop state with `currentVfs`, `iterations`, `totalTokens`, `totalCostCents`, and timers.
2. Evaluate each iteration with `evaluator.evaluate(currentVfs, context)`.
3. On acceptable evaluation, append a passing iteration (`reflection: null`), emit `onIteration`, optionally extract lessons, emit `onFixed`, and return success.
4. On failing evaluation, produce reflection via `reflectionNode.reflect(...)` when enabled and available, otherwise use fallback reflection from error text.
5. Apply pre-fix cost guard (`maxCostCents`).
6. Apply fix via `fixer.fix(currentVfs, reflection, context)`, then merge token and cost accounting.
7. Record iteration and emit `onIteration`.
8. Apply post-fix cost guard.
9. If loop exits without success and the last iteration modified files, run one final evaluation pass.
10. If final evaluation is acceptable, emit `onFixed` and return success.
11. Otherwise emit `onExhausted` with up to 10 lint errors from the last iteration and return failure.

Fallback reflection details.

- Category inference is regex-based over lint and test error text.
- File extraction uses `/[\w./-]+\.[tj]sx?/` with a leading `/` path expectation.
- Returned fallback reflection uses `confidence: 0.5` and a synthetic `suggestedFix`.

Cost accounting details.

- Cost estimate uses `(inputTokens + outputTokens) / 1000 * 0.3` cents.
- Reflection and fix token usage are included in `totalTokens`.
- Lesson extraction token usage is returned by extractor but is not currently merged into `totalTokens` or `totalCostCents`.

## Key APIs and Types
Constructors.

- `new SelfCorrectionLoop(deps, config?)`
- `new ReflectionNode({ registry, modelTier?, systemPrompt? })`
- `new LessonExtractor({ registry?, modelTier? })`

Runtime methods.

- `SelfCorrectionLoop.run(generatedCode, context?) => Promise<CorrectionResult>`
- `ReflectionNode.reflect(vfs, evaluation) => Promise<ReflectionResult>`
- `LessonExtractor.extract(iterations, context?) => Promise<LessonExtractionResult>`

Core contracts.

- `CodeEvaluator.evaluate(vfs, context?) => Promise<EvaluationResult>`
- `CodeFixer.fix(vfs, reflection, context?) => Promise<{ vfs; filesModified; tokensUsed }>`

Schema and defaults.

- `ReflectionSchema` validates `rootCause`, `affectedFiles`, `suggestedFix`, `confidence` (0..1), `category`, and optional `additionalContext`.
- `DEFAULT_CORRECTION_CONFIG` sets `maxIterations: 3`, `maxCostCents: 50`, `qualityThreshold: 70`, `enableReflection: true`, and `enableLessonExtraction: true`.

## Dependencies
Direct imports used by `src/correction/*`.

- `@dzupagent/core/llm` for `TokenUsage`, `ModelRegistry`, `ModelTier`, and `extractTokenUsage`.
- `@langchain/core/messages` for `SystemMessage` and `HumanMessage`.
- `zod` for reflection output schema validation.

Package metadata context from `packages/codegen/package.json`.

- Runtime dependency includes `@dzupagent/core`.
- Peer dependencies used by correction code include `@langchain/core` and `zod`.
- `@langchain/langgraph` is a package peer dependency but is not imported by correction module files.

## Integration Points
Internal integration points.

- Correction APIs are exported from `src/correction/index.ts`.
- Root package re-exports correction APIs from `src/index.ts`.
- Quality coupling is contract-based through `EvaluationResult.qualityScore`.
- VFS coupling is shape-based through `Record<string, string>` and does not require `VirtualFS` instances.

Repository usage snapshot.

- Direct non-test consumers of `SelfCorrectionLoop`, `ReflectionNode`, and `LessonExtractor` were not found outside correction tests in `packages/codegen/src/__tests__`.
- Package docs under `packages/codegen/docs/*` reference this subsystem as architecture/documentation integration.

## Testing and Observability
Test and coverage configuration from `packages/codegen/vitest.config.ts`.

- Node test environment.
- Include globs `src/**/*.test.ts` and `src/**/*.spec.ts`.
- Coverage thresholds: statements 60, branches 50, functions 50, lines 60.

Primary correction test files.

- `src/__tests__/self-correction-loop.test.ts`
- `src/__tests__/self-correction-loop-extended.test.ts`
- `src/__tests__/lesson-extractor-and-reflection.test.ts`

Validated behavior areas.

- Immediate pass, multi-iteration correction, exhaustion, and final verification paths.
- Acceptance criteria handling for `passed`, `qualityScore`, and remaining lint errors.
- Fallback reflection category detection and affected-file extraction.
- Reflection JSON parsing, malformed-response fallback, and schema enforcement.
- Lesson extraction in heuristic mode and LLM mode, including category normalization and frequency aggregation.
- Model-tier defaults and overrides (`ReflectionNode` default `codegen`, `LessonExtractor` default `chat`).
- Event payload content for `onIteration`, `onFixed`, and `onExhausted`.
- Token/cost accounting and max-cost stop behavior.
- VFS input immutability and cumulative mutation in `finalCode`.

Observability surface.

- Callback hooks: `onIteration(event)`, `onFixed(event)`, and `onExhausted(event)`.
- Timing fields: per iteration `durationMs` and aggregate `totalDurationMs`.

## Risks and TODOs
- Cost modeling is static and not provider/model specific, so real spend can diverge.
- Lesson extraction token usage is not folded into loop-level totals.
- Regex fallback reflection parsing can misclassify errors or miss relevant files.
- Reflection prompts can be large (up to 30 files and up to 3000 chars per file), increasing latency and token cost.
- Loop reliability depends on injected evaluator/fixer behavior; there is no built-in retry/backoff around dependency failures.
- Current repository usage is mostly test-driven, which increases drift risk between exported surface and production integrations.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js