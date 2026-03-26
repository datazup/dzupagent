/**
 * LessonExtractor — extracts reusable lessons from successful correction sessions.
 *
 * After a correction loop successfully fixes code, the LessonExtractor analyzes
 * the iteration history to produce generalizable rules that can be stored in
 * memory and used to prevent similar errors in future sessions.
 *
 * Lessons follow the pattern: "When doing X in context Y, always Z."
 *
 * The extractor can operate in two modes:
 * - LLM mode: uses an LLM to generate nuanced, human-readable rules
 * - Heuristic mode: uses pattern matching on error categories (no LLM needed)
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { ModelRegistry, ModelTier, TokenUsage } from '@forgeagent/core'
import { extractTokenUsage } from '@forgeagent/core'
import type { CorrectionIteration, Lesson, ErrorCategory, CorrectionContext } from './correction-types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LessonExtractorConfig {
  /** ModelRegistry for LLM-based extraction (optional — omit for heuristic-only) */
  registry?: ModelRegistry
  /** Model tier to use for lesson generation (default: 'chat') */
  modelTier?: ModelTier
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface LessonExtractionResult {
  lessons: Lesson[]
  tokensUsed: TokenUsage
}

// ---------------------------------------------------------------------------
// System prompt for LLM-based extraction
// ---------------------------------------------------------------------------

const LESSON_SYSTEM_PROMPT = `You are a senior developer analyzing a bug fix session.
Given the errors that were found and how they were fixed, extract 1-3 reusable lessons.

Each lesson should be:
- A general rule (not specific to this exact code)
- Actionable (tells you what to do or avoid)
- Categorized by error type

Respond as a JSON array of objects with:
{ "rule": string, "category": string, "context": string }

Categories: syntax_error, type_error, logic_error, missing_import, api_misuse, test_failure, lint_violation, runtime_error`

// ---------------------------------------------------------------------------
// Heuristic lesson templates by error category
// ---------------------------------------------------------------------------

const HEURISTIC_TEMPLATES: Record<ErrorCategory, string[]> = {
  syntax_error: [
    'Validate syntax before committing generated code to VFS',
    'Check for balanced brackets and proper statement termination',
  ],
  type_error: [
    'Ensure all function parameters and return types are explicitly typed',
    'Verify type compatibility when passing values between functions',
  ],
  logic_error: [
    'Add edge case handling for empty arrays, null values, and boundary conditions',
    'Verify that conditional logic covers all expected branches',
  ],
  missing_import: [
    'Verify all referenced symbols have corresponding import statements',
    'Check that import paths use the correct file extension (.js for ESM)',
  ],
  api_misuse: [
    'Consult API documentation before using unfamiliar methods',
    'Verify method signatures match expected parameters and return types',
  ],
  test_failure: [
    'Ensure test setup matches the actual module interface',
    'Verify mock implementations match the real API surface',
  ],
  lint_violation: [
    'Run lint checks before finalizing generated code',
    'Avoid console.log and debugger statements in production code',
  ],
  runtime_error: [
    'Add null checks and error handling for external dependencies',
    'Validate inputs before processing to prevent runtime exceptions',
  ],
}

// ---------------------------------------------------------------------------
// LessonExtractor
// ---------------------------------------------------------------------------

/**
 * Extracts reusable lessons from correction iterations.
 *
 * When an LLM registry is provided, uses LLM-based extraction for
 * nuanced, context-aware lessons. Otherwise falls back to heuristic
 * template matching based on error categories.
 */
export class LessonExtractor {
  private readonly registry?: ModelRegistry
  private readonly modelTier: ModelTier

  constructor(config?: LessonExtractorConfig) {
    if (config?.registry != null) {
      this.registry = config.registry
    }
    this.modelTier = config?.modelTier ?? 'chat'
  }

  /**
   * Extract lessons from a completed (successful) correction session.
   */
  async extract(
    iterations: CorrectionIteration[],
    _context?: CorrectionContext,
  ): Promise<LessonExtractionResult> {
    // Only extract lessons when there were actual fixes applied
    const fixIterations = iterations.filter(it => it.reflection !== null)
    if (fixIterations.length === 0) {
      return { lessons: [], tokensUsed: zeroTokens() }
    }

    // Try LLM extraction if registry is available
    if (this.registry) {
      return this.extractWithLLM(fixIterations)
    }

    // Fallback to heuristic extraction
    return {
      lessons: this.extractWithHeuristics(fixIterations),
      tokensUsed: zeroTokens(),
    }
  }

  /**
   * LLM-based lesson extraction for richer, more contextual rules.
   */
  private async extractWithLLM(
    fixIterations: CorrectionIteration[],
  ): Promise<LessonExtractionResult> {
    const model = this.registry!.getModel(this.modelTier)

    const iterationSummaries = fixIterations.map((it, idx) => {
      const errors = [
        ...it.evaluation.lintErrors.slice(0, 5),
        ...(it.evaluation.testResults?.errors.slice(0, 3) ?? []),
      ]
      return [
        `### Iteration ${idx + 1}`,
        `Errors: ${errors.join('; ') || 'none'}`,
        `Root cause: ${it.reflection?.rootCause ?? 'unknown'}`,
        `Category: ${it.reflection?.category ?? 'unknown'}`,
        `Fix: ${it.reflection?.suggestedFix ?? 'unknown'}`,
        `Files modified: ${it.filesModified.join(', ') || 'none'}`,
      ].join('\n')
    })

    const userMessage = [
      '## Correction Session Summary',
      '',
      iterationSummaries.join('\n\n'),
      '',
      'Extract reusable lessons from this session as a JSON array.',
    ].join('\n')

    const response = await model.invoke([
      new SystemMessage(LESSON_SYSTEM_PROMPT),
      new HumanMessage(userMessage),
    ])

    const rawContent = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)

    const modelName = (model as unknown as { model?: string }).model
    const tokensUsed = extractTokenUsage(response, modelName)
    const lessons = this.parseLessons(rawContent, fixIterations)

    return { lessons, tokensUsed }
  }

  /**
   * Parse LLM response into Lesson objects with fallback.
   */
  private parseLessons(
    raw: string,
    fixIterations: CorrectionIteration[],
  ): Lesson[] {
    // Try JSON extraction
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item): item is Record<string, unknown> =>
              typeof item === 'object' && item !== null && 'rule' in item,
            )
            .map(item => ({
              rule: String(item['rule'] ?? ''),
              category: this.normalizeCategory(String(item['category'] ?? 'logic_error')),
              context: String(item['context'] ?? ''),
              frequency: 1,
            }))
            .filter(l => l.rule.length > 0)
        }
      } catch {
        // Fall through to heuristic
      }
    }

    // Fallback to heuristic
    return this.extractWithHeuristics(fixIterations)
  }

  /**
   * Normalize a category string to a valid ErrorCategory.
   */
  private normalizeCategory(raw: string): ErrorCategory {
    const normalized = raw.toLowerCase().replace(/[^a-z_]/g, '') as ErrorCategory
    const valid: ErrorCategory[] = [
      'syntax_error', 'type_error', 'logic_error', 'missing_import',
      'api_misuse', 'test_failure', 'lint_violation', 'runtime_error',
    ]
    return valid.includes(normalized) ? normalized : 'logic_error'
  }

  /**
   * Heuristic-based lesson extraction from error categories.
   */
  private extractWithHeuristics(fixIterations: CorrectionIteration[]): Lesson[] {
    const categoryCounts = new Map<ErrorCategory, number>()

    for (const it of fixIterations) {
      if (it.reflection) {
        const cat = it.reflection.category
        categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
      }
    }

    const lessons: Lesson[] = []
    for (const [category, count] of categoryCounts) {
      const templates = HEURISTIC_TEMPLATES[category]
      if (templates && templates.length > 0) {
        // Pick the first template for this category
        lessons.push({
          rule: templates[0]!,
          category,
          context: `Observed ${count} time(s) during correction`,
          frequency: count,
        })
      }
    }

    return lessons
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroTokens(): TokenUsage {
  return { model: '', inputTokens: 0, outputTokens: 0 }
}
