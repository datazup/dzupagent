/**
 * Types for the self-correction loop in code generation pipelines.
 *
 * The correction loop follows the pattern:
 *   Evaluate -> Diagnose -> Reflect -> Revise -> Verify
 *
 * Each iteration is tracked with full context so that lessons can
 * be extracted and the loop can be introspected after completion.
 */

import type { TokenUsage } from '@forgeagent/core'

// ---------------------------------------------------------------------------
// Error categories used by reflection and diagnosis
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'syntax_error'
  | 'type_error'
  | 'logic_error'
  | 'missing_import'
  | 'api_misuse'
  | 'test_failure'
  | 'lint_violation'
  | 'runtime_error'

// ---------------------------------------------------------------------------
// Evaluation output — raw signals from tests, lint, typecheck
// ---------------------------------------------------------------------------

export interface EvaluationResult {
  /** Did all checks pass? */
  passed: boolean
  /** Test results (if tests were run) */
  testResults?: {
    passed: number
    failed: number
    errors: string[]
    failedTests: Array<{ name: string; error: string; file: string }>
  }
  /** Lint/typecheck errors */
  lintErrors: string[]
  /** Quality score (0-100) from QualityScorer */
  qualityScore: number
  /** Raw stderr/stdout from sandbox, truncated */
  rawOutput?: string
}

// ---------------------------------------------------------------------------
// Reflection — structured LLM critique of generated code
// ---------------------------------------------------------------------------

export interface Reflection {
  /** High-level root cause description */
  rootCause: string
  /** Files affected by the issue */
  affectedFiles: string[]
  /** Concrete suggested fix description */
  suggestedFix: string
  /** LLM confidence in the diagnosis (0-1) */
  confidence: number
  /** Classified error category */
  category: ErrorCategory
  /** Additional context that might help the fixer */
  additionalContext?: string
}

// ---------------------------------------------------------------------------
// Single iteration in the correction loop
// ---------------------------------------------------------------------------

export interface CorrectionIteration {
  /** 0-based iteration index */
  index: number
  /** Evaluation results for this iteration */
  evaluation: EvaluationResult
  /** Reflection/diagnosis (null on first iteration if code passes) */
  reflection: Reflection | null
  /** VFS snapshot after applying fixes (Record<path, content>) */
  vfsSnapshot: Record<string, string>
  /** Files modified during this iteration's fix */
  filesModified: string[]
  /** Tokens consumed during this iteration (model may be empty for aggregated usage) */
  tokensUsed: TokenUsage
  /** Wall-clock duration of this iteration in ms */
  durationMs: number
}

// ---------------------------------------------------------------------------
// Final result of the correction loop
// ---------------------------------------------------------------------------

export interface CorrectionResult {
  /** The final code (VFS snapshot) after all iterations */
  finalCode: Record<string, string>
  /** Complete iteration history */
  iterations: CorrectionIteration[]
  /** Total token usage across all iterations */
  totalTokens: TokenUsage
  /** Estimated total cost in cents */
  totalCostCents: number
  /** Whether the code was successfully fixed */
  wasFixed: boolean
  /** Total number of iterations executed */
  iterationCount: number
  /** Total wall-clock duration in ms */
  totalDurationMs: number
  /** Lessons extracted from the correction session */
  lessons: Lesson[]
}

// ---------------------------------------------------------------------------
// Context passed into the correction loop
// ---------------------------------------------------------------------------

export interface CorrectionContext {
  /** Original generation plan or spec, for reference */
  plan?: Record<string, unknown>
  /** Tech stack metadata */
  techStack?: Record<string, string>
  /** Prior lessons from memory that may help avoid known issues */
  priorLessons?: Lesson[]
  /** System prompt for the reflection LLM */
  reflectionSystemPrompt?: string
  /** System prompt for the fix LLM */
  fixSystemPrompt?: string
}

// ---------------------------------------------------------------------------
// Lesson — reusable insight extracted from a correction session
// ---------------------------------------------------------------------------

export interface Lesson {
  /** Human-readable rule, e.g. "When using Prisma, always import PrismaClient" */
  rule: string
  /** Error category this lesson applies to */
  category: ErrorCategory
  /** Surrounding context: framework, file pattern, etc. */
  context: string
  /** How many times this pattern has been observed */
  frequency: number
}

// ---------------------------------------------------------------------------
// Configuration for the self-correction loop
// ---------------------------------------------------------------------------

export interface SelfCorrectionConfig {
  /** Maximum number of correction iterations (default: 3) */
  maxIterations: number
  /** Maximum cost in cents before aborting (default: 50) */
  maxCostCents: number
  /** Quality score threshold to consider code acceptable (default: 70) */
  qualityThreshold: number
  /** Enable LLM-based reflection between iterations (default: true) */
  enableReflection: boolean
  /** Enable lesson extraction after successful fixes (default: true) */
  enableLessonExtraction: boolean
}

export const DEFAULT_CORRECTION_CONFIG: SelfCorrectionConfig = {
  maxIterations: 3,
  maxCostCents: 50,
  qualityThreshold: 70,
  enableReflection: true,
  enableLessonExtraction: true,
}

// ---------------------------------------------------------------------------
// Evaluator and Fixer interfaces — injectable for testing
// ---------------------------------------------------------------------------

/** Evaluates generated code and returns structured results */
export interface CodeEvaluator {
  evaluate(vfs: Record<string, string>, context?: CorrectionContext): Promise<EvaluationResult>
}

/** Applies fixes to code based on reflection output */
export interface CodeFixer {
  fix(
    vfs: Record<string, string>,
    reflection: Reflection,
    context?: CorrectionContext,
  ): Promise<{ vfs: Record<string, string>; filesModified: string[]; tokensUsed: TokenUsage }>
}

// ---------------------------------------------------------------------------
// Event payloads emitted during correction
// ---------------------------------------------------------------------------

export interface CorrectionIterationEvent {
  iteration: number
  evaluation: EvaluationResult
  reflection: Reflection | null
  filesModified: string[]
  durationMs: number
}

export interface CorrectionFixedEvent {
  iterationCount: number
  totalDurationMs: number
  lessons: Lesson[]
}

export interface CorrectionExhaustedEvent {
  iterationCount: number
  totalDurationMs: number
  lastErrors: string[]
}
