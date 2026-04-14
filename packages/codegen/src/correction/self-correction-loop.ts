/**
 * SelfCorrectionLoop — iterative correction pattern for code generation.
 *
 * Implements the five-mechanism self-correction cycle from the research:
 *   1. Error Detection (evaluate)
 *   2. Root Cause Analysis (reflect via ReflectionNode)
 *   3. Rule Generation (lesson extraction)
 *   4. Memory Consolidation (lessons returned for external storage)
 *   5. Skill Acquisition (escalation strategy adapts per iteration)
 *
 * The loop operates on a VFS snapshot (Record<string, string>) and uses
 * injectable CodeEvaluator and CodeFixer interfaces so that callers can
 * provide real or mock implementations.
 *
 * Events are emitted through a simple callback interface rather than
 * coupling to DzupEventBus directly, keeping the module self-contained.
 */

import type { TokenUsage } from '@dzupagent/core'
import type {
  SelfCorrectionConfig,
  CorrectionContext,
  CorrectionResult,
  CorrectionIteration,
  EvaluationResult,
  Reflection,
  Lesson,
  CodeEvaluator,
  CodeFixer,
  CorrectionIterationEvent,
  CorrectionFixedEvent,
  CorrectionExhaustedEvent,
} from './correction-types.js'
import { DEFAULT_CORRECTION_CONFIG } from './correction-types.js'
import type { ReflectionNode } from './reflection-node.js'
import type { LessonExtractor } from './lesson-extractor.js'

// ---------------------------------------------------------------------------
// Event listener types
// ---------------------------------------------------------------------------

export interface CorrectionEventListeners {
  onIteration?: (event: CorrectionIterationEvent) => void
  onFixed?: (event: CorrectionFixedEvent) => void
  onExhausted?: (event: CorrectionExhaustedEvent) => void
}

// ---------------------------------------------------------------------------
// Constructor dependencies
// ---------------------------------------------------------------------------

export interface SelfCorrectionDeps {
  evaluator: CodeEvaluator
  fixer: CodeFixer
  reflectionNode?: ReflectionNode
  lessonExtractor?: LessonExtractor
  listeners?: CorrectionEventListeners
}

// ---------------------------------------------------------------------------
// SelfCorrectionLoop
// ---------------------------------------------------------------------------

/**
 * Runs an iterative correction loop on generated code.
 *
 * Each iteration:
 *  a. Evaluate: run tests, lint, typecheck, quality scoring
 *  b. Diagnose: if errors found, use ReflectionNode to identify root cause
 *  c. Reflect: produce structured critique
 *  d. Revise: apply targeted fixes via CodeFixer
 *  e. Verify: re-run evaluation to check if fix worked
 *
 * The loop terminates when:
 *  - Code passes all checks (qualityScore >= threshold, no errors)
 *  - maxIterations is reached
 *  - maxCostCents is exceeded
 */
export class SelfCorrectionLoop {
  private readonly config: SelfCorrectionConfig
  private readonly evaluator: CodeEvaluator
  private readonly fixer: CodeFixer
  private readonly reflectionNode?: ReflectionNode
  private readonly lessonExtractor?: LessonExtractor
  private readonly listeners: CorrectionEventListeners

  constructor(
    deps: SelfCorrectionDeps,
    config?: Partial<SelfCorrectionConfig>,
  ) {
    this.config = { ...DEFAULT_CORRECTION_CONFIG, ...config }
    this.evaluator = deps.evaluator
    this.fixer = deps.fixer
    if (deps.reflectionNode != null) {
      this.reflectionNode = deps.reflectionNode
    }
    if (deps.lessonExtractor != null) {
      this.lessonExtractor = deps.lessonExtractor
    }
    this.listeners = deps.listeners ?? {}
  }

  /**
   * Run the self-correction loop on generated code.
   *
   * @param generatedCode - VFS snapshot (Record<path, content>) of generated code
   * @param context - Additional context for evaluation and fixing
   * @returns CorrectionResult with final code, iteration history, and lessons
   */
  async run(
    generatedCode: Record<string, string>,
    context?: CorrectionContext,
  ): Promise<CorrectionResult> {
    const loopStart = Date.now()
    const iterations: CorrectionIteration[] = []
    let currentVfs = { ...generatedCode }
    let totalTokens = zeroTokens()
    let totalCostCents = 0

    for (let i = 0; i < this.config.maxIterations; i++) {
      const iterStart = Date.now()

      // --- Step (a): Evaluate ---
      const evaluation = await this.evaluator.evaluate(currentVfs, context)

      // --- Check if code passes ---
      if (this.isAcceptable(evaluation)) {
        const iteration = buildIteration(i, evaluation, null, currentVfs, [], zeroTokens(), Date.now() - iterStart)
        iterations.push(iteration)
        this.emitIteration(iteration)

        // Extract lessons from the correction session
        const lessons = await this.maybeExtractLessons(iterations, context)
        addTokens(totalTokens, iteration.tokensUsed)

        this.listeners.onFixed?.({
          iterationCount: iterations.length,
          totalDurationMs: Date.now() - loopStart,
          lessons,
        })

        return buildResult(currentVfs, iterations, totalTokens, totalCostCents, true, Date.now() - loopStart, lessons)
      }

      // --- Step (b)+(c): Diagnose and Reflect ---
      let reflection: Reflection | null = null
      let reflectionTokens = zeroTokens()

      if (this.config.enableReflection && this.reflectionNode) {
        const result = await this.reflectionNode.reflect(currentVfs, evaluation)
        reflection = result.reflection
        reflectionTokens = result.tokensUsed
        addTokens(totalTokens, reflectionTokens)
        totalCostCents += estimateCost(reflectionTokens)
      } else {
        // Build a minimal reflection from error signals when no LLM is available
        reflection = buildFallbackReflection(evaluation)
      }

      // --- Cost guard ---
      if (totalCostCents >= this.config.maxCostCents) {
        const iteration = buildIteration(i, evaluation, reflection, currentVfs, [], reflectionTokens, Date.now() - iterStart)
        iterations.push(iteration)
        this.emitIteration(iteration)
        break
      }

      // --- Step (d): Revise ---
      const fixResult = await this.fixer.fix(currentVfs, reflection, context)
      currentVfs = fixResult.vfs
      addTokens(totalTokens, fixResult.tokensUsed)
      totalCostCents += estimateCost(fixResult.tokensUsed)

      const iterTokens = mergeTokens(reflectionTokens, fixResult.tokensUsed)
      const iteration = buildIteration(
        i,
        evaluation,
        reflection,
        currentVfs,
        fixResult.filesModified,
        iterTokens,
        Date.now() - iterStart,
      )
      iterations.push(iteration)
      this.emitIteration(iteration)

      // --- Cost guard after fix ---
      if (totalCostCents >= this.config.maxCostCents) {
        break
      }
    }

    // --- Step (e): Final verification ---
    // If we exited the loop without returning, do one final eval to see if the last fix worked
    if (iterations.length > 0) {
      const lastIteration = iterations[iterations.length - 1]!
      if (lastIteration.filesModified.length > 0) {
        const finalEval = await this.evaluator.evaluate(currentVfs, context)
        if (this.isAcceptable(finalEval)) {
          const lessons = await this.maybeExtractLessons(iterations, context)
          this.listeners.onFixed?.({
            iterationCount: iterations.length,
            totalDurationMs: Date.now() - loopStart,
            lessons,
          })
          return buildResult(currentVfs, iterations, totalTokens, totalCostCents, true, Date.now() - loopStart, lessons)
        }
      }
    }

    // --- Exhausted ---
    const lastErrors = iterations.length > 0
      ? iterations[iterations.length - 1]!.evaluation.lintErrors.slice(0, 10)
      : []

    this.listeners.onExhausted?.({
      iterationCount: iterations.length,
      totalDurationMs: Date.now() - loopStart,
      lastErrors,
    })

    return buildResult(currentVfs, iterations, totalTokens, totalCostCents, false, Date.now() - loopStart, [])
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private isAcceptable(evaluation: EvaluationResult): boolean {
    return (
      evaluation.passed &&
      evaluation.qualityScore >= this.config.qualityThreshold &&
      evaluation.lintErrors.length === 0
    )
  }

  private emitIteration(iteration: CorrectionIteration): void {
    this.listeners.onIteration?.({
      iteration: iteration.index,
      evaluation: iteration.evaluation,
      reflection: iteration.reflection,
      filesModified: iteration.filesModified,
      durationMs: iteration.durationMs,
    })
  }

  private async maybeExtractLessons(
    iterations: CorrectionIteration[],
    context?: CorrectionContext,
  ): Promise<Lesson[]> {
    if (!this.config.enableLessonExtraction || !this.lessonExtractor) {
      return []
    }
    const result = await this.lessonExtractor.extract(iterations, context)
    return result.lessons
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function zeroTokens(): TokenUsage {
  return { model: '', inputTokens: 0, outputTokens: 0 }
}

function totalTokens(t: TokenUsage): number {
  return t.inputTokens + t.outputTokens
}

function addTokens(target: TokenUsage, source: TokenUsage): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
}

function mergeTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    model: a.model || b.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/** Rough cost estimation: ~$0.003 per 1K tokens (blended average) */
function estimateCost(tokens: TokenUsage): number {
  return (totalTokens(tokens) / 1000) * 0.3
}

function buildIteration(
  index: number,
  evaluation: EvaluationResult,
  reflection: Reflection | null,
  vfsSnapshot: Record<string, string>,
  filesModified: string[],
  tokensUsed: TokenUsage,
  durationMs: number,
): CorrectionIteration {
  return { index, evaluation, reflection, vfsSnapshot, filesModified, tokensUsed, durationMs }
}

function buildResult(
  finalCode: Record<string, string>,
  iterations: CorrectionIteration[],
  totalTokens: TokenUsage,
  totalCostCents: number,
  wasFixed: boolean,
  totalDurationMs: number,
  lessons: Lesson[],
): CorrectionResult {
  return {
    finalCode,
    iterations,
    totalTokens,
    totalCostCents,
    wasFixed,
    iterationCount: iterations.length,
    totalDurationMs,
    lessons,
  }
}

function buildFallbackReflection(evaluation: EvaluationResult): Reflection {
  const allErrors = [
    ...evaluation.lintErrors,
    ...(evaluation.testResults?.errors ?? []),
  ]

  // Try to guess category from error messages
  const errorText = allErrors.join(' ').toLowerCase()
  let category: Reflection['category'] = 'logic_error'
  if (/import|module not found|cannot find/.test(errorText)) category = 'missing_import'
  else if (/type\s*error|is not assignable|mismatch/.test(errorText)) category = 'type_error'
  else if (/syntax|unexpected token|parse/.test(errorText)) category = 'syntax_error'
  else if (/test.*fail|expect|assert/.test(errorText)) category = 'test_failure'
  else if (/lint|eslint|no-unused/.test(errorText)) category = 'lint_violation'

  // Extract file paths from error messages
  const filePattern = /\/[\w./-]+\.[tj]sx?/g
  const affectedFiles: string[] = []
  for (const err of allErrors) {
    const matches = err.match(filePattern)
    if (matches) {
      affectedFiles.push(...matches)
    }
  }

  return {
    rootCause: allErrors[0] ?? 'Unknown error',
    affectedFiles: [...new Set(affectedFiles)],
    suggestedFix: `Fix the ${category.replace('_', ' ')} in the affected files`,
    confidence: 0.5,
    category,
  }
}
