/**
 * ReflectionNode — LLM-based structured critique of generated code.
 *
 * Takes code, errors, test results, and lint output, then produces a
 * structured Reflection with root cause analysis, affected files,
 * and suggested fixes.
 *
 * The reflection is returned as a Zod-validated structured output so
 * that downstream consumers (the fixer, lesson extractor) can rely
 * on a stable schema.
 */

import { z } from 'zod'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { ModelRegistry, ModelTier, TokenUsage } from '@forgeagent/core'
import { extractTokenUsage } from '@forgeagent/core'
import type { EvaluationResult, Reflection, ErrorCategory } from './correction-types.js'

// ---------------------------------------------------------------------------
// Zod schema for structured LLM output
// ---------------------------------------------------------------------------

const ERROR_CATEGORIES: [ErrorCategory, ...ErrorCategory[]] = [
  'syntax_error',
  'type_error',
  'logic_error',
  'missing_import',
  'api_misuse',
  'test_failure',
  'lint_violation',
  'runtime_error',
]

export const ReflectionSchema = z.object({
  rootCause: z.string().describe('Root cause of the failure in 1-2 sentences'),
  affectedFiles: z.array(z.string()).describe('File paths that need to be fixed'),
  suggestedFix: z.string().describe('Concrete description of the fix to apply'),
  confidence: z.number().min(0).max(1).describe('Confidence in this diagnosis (0-1)'),
  category: z.enum(ERROR_CATEGORIES).describe('Classified error category'),
  additionalContext: z.string().optional().describe('Any additional context that may help'),
})

// ---------------------------------------------------------------------------
// Default system prompt for reflection
// ---------------------------------------------------------------------------

const DEFAULT_REFLECTION_PROMPT = `You are a senior code reviewer analyzing generated code that failed validation.
Your job is to:
1. Identify the ROOT CAUSE of the failure (not just the symptom)
2. Determine which files need to be fixed
3. Suggest a concrete fix
4. Rate your confidence in the diagnosis

Be precise and actionable. Focus on the most impactful issue first.
If multiple errors share a root cause, group them under one diagnosis.`

// ---------------------------------------------------------------------------
// ReflectionNode
// ---------------------------------------------------------------------------

export interface ReflectionNodeConfig {
  registry: ModelRegistry
  modelTier?: ModelTier
  systemPrompt?: string
}

export interface ReflectionResult {
  reflection: Reflection
  tokensUsed: TokenUsage
}

/**
 * Analyzes code errors and produces a structured reflection for the correction loop.
 *
 * The reflection includes root cause analysis, affected files, and a
 * suggested fix that the CodeFixer can act on.
 */
export class ReflectionNode {
  private readonly registry: ModelRegistry
  private readonly modelTier: ModelTier
  private readonly systemPrompt: string

  constructor(config: ReflectionNodeConfig) {
    this.registry = config.registry
    this.modelTier = config.modelTier ?? 'codegen'
    this.systemPrompt = config.systemPrompt ?? DEFAULT_REFLECTION_PROMPT
  }

  /**
   * Produce a structured reflection given the current code state and evaluation results.
   */
  async reflect(
    vfs: Record<string, string>,
    evaluation: EvaluationResult,
  ): Promise<ReflectionResult> {
    const model = this.registry.getModel(this.modelTier)
    const userMessage = this.buildUserMessage(vfs, evaluation)

    const response = await model.invoke([
      new SystemMessage(this.systemPrompt),
      new HumanMessage(userMessage),
    ])

    const rawContent = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)

    const reflection = this.parseReflection(rawContent)
    const modelName = (model as unknown as { model?: string }).model
    const tokensUsed = extractTokenUsage(response, modelName)

    return { reflection, tokensUsed }
  }

  /**
   * Build the user message with code context and error information.
   */
  private buildUserMessage(
    vfs: Record<string, string>,
    evaluation: EvaluationResult,
  ): string {
    const sections: string[] = []

    // Error summary
    sections.push('## Errors Found')
    if (evaluation.lintErrors.length > 0) {
      sections.push('### Lint/Type Errors')
      sections.push(evaluation.lintErrors.slice(0, 20).join('\n'))
    }
    if (evaluation.testResults && evaluation.testResults.failed > 0) {
      sections.push('### Test Failures')
      sections.push(`${evaluation.testResults.passed} passed, ${evaluation.testResults.failed} failed`)
      for (const ft of evaluation.testResults.failedTests.slice(0, 10)) {
        sections.push(`- ${ft.file}: ${ft.name}\n  Error: ${ft.error}`)
      }
      if (evaluation.testResults.errors.length > 0) {
        sections.push('### Test Errors')
        sections.push(evaluation.testResults.errors.slice(0, 5).join('\n'))
      }
    }
    sections.push(`Quality Score: ${evaluation.qualityScore}/100`)

    // Raw output (truncated)
    if (evaluation.rawOutput) {
      sections.push('### Raw Output (truncated)')
      sections.push(evaluation.rawOutput.slice(0, 2000))
    }

    // Source files (limit to relevant files, keep context window manageable)
    const entries = Object.entries(vfs)
    const filesToShow = entries.slice(0, 30)
    sections.push('\n## Source Files')
    for (const [path, content] of filesToShow) {
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content
      sections.push(`### ${path}\n\`\`\`\n${truncated}\n\`\`\``)
    }
    if (entries.length > 30) {
      sections.push(`... and ${entries.length - 30} more files`)
    }

    sections.push('\nAnalyze the errors above and provide a structured diagnosis as JSON matching this schema:')
    sections.push('{ rootCause: string, affectedFiles: string[], suggestedFix: string, confidence: number (0-1), category: "syntax_error"|"type_error"|"logic_error"|"missing_import"|"api_misuse"|"test_failure"|"lint_violation"|"runtime_error", additionalContext?: string }')

    return sections.join('\n\n')
  }

  /**
   * Parse the LLM response into a validated Reflection.
   * Falls back to regex extraction if JSON parsing fails.
   */
  private parseReflection(raw: string): Reflection {
    // Try to extract JSON from the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed: unknown = JSON.parse(jsonMatch[0])
        const validated = ReflectionSchema.safeParse(parsed)
        if (validated.success) {
          const { additionalContext, ...rest } = validated.data
          return additionalContext != null ? { ...rest, additionalContext } : rest
        }
      } catch {
        // JSON parse failed, fall through to regex
      }
    }

    // Fallback: extract what we can from the text
    return this.extractReflectionFromText(raw)
  }

  /**
   * Regex-based fallback for extracting reflection from unstructured text.
   */
  private extractReflectionFromText(text: string): Reflection {
    const rootCauseMatch = text.match(/root\s*cause[:\s]*(.+?)(?:\n|$)/i)
    const fixMatch = text.match(/(?:fix|solution|suggestion)[:\s]*(.+?)(?:\n|$)/i)

    // Extract file paths from backticks or common patterns
    const fileMatches = text.match(/[`'"]?(\S+\.[tj]sx?)[`'"]?/g) ?? []
    const affectedFiles = fileMatches
      .map(m => m.replace(/[`'"]/g, ''))
      .filter(f => f.includes('/') || f.includes('.'))

    // Guess category from keywords
    let category: ErrorCategory = 'logic_error'
    if (/import|require|module not found/i.test(text)) category = 'missing_import'
    else if (/type\s*error|type.*mismatch|assignable/i.test(text)) category = 'type_error'
    else if (/syntax|unexpected|parse/i.test(text)) category = 'syntax_error'
    else if (/test.*fail|expect|assert/i.test(text)) category = 'test_failure'
    else if (/lint|eslint|prettier/i.test(text)) category = 'lint_violation'

    return {
      rootCause: rootCauseMatch?.[1]?.trim() ?? 'Unable to determine root cause from LLM response',
      affectedFiles: [...new Set(affectedFiles)],
      suggestedFix: fixMatch?.[1]?.trim() ?? text.slice(0, 200),
      confidence: 0.3,
      category,
    }
  }
}
