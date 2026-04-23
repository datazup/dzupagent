/**
 * RunReflector — hybrid heuristic + optional LLM scoring of agent run quality.
 *
 * By default, pure heuristic analysis with zero LLM overhead.
 * When configured with an LLM function, can enhance scoring with
 * LLM-powered reflection (always or only when heuristic score is low).
 * Designed to run on every single agent run without measurable latency impact
 * in heuristic-only mode.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Individual dimension scores, each in the range [0, 1]. */
export interface ReflectionDimensions {
  /** Did the output address the input question/task? (0-1) */
  completeness: number
  /** Is the output well-structured and coherent? (0-1) */
  coherence: number
  /** Were tool calls successful? (0-1) */
  toolSuccess: number
  /** Was the response concise (not overly verbose)? (0-1) */
  conciseness: number
  /** Were there any error/retry signals? (0-1, 1 = no errors) */
  reliability: number
}

/** Configuration for optional LLM-enhanced reflection. */
export interface ReflectorConfig {
  /** Optional LLM for enhanced reflection scoring. */
  llm?: (prompt: string) => Promise<string>
  /** Use LLM reflection on every run, or only when heuristic score is low. Default: 'on-low-score'. */
  llmMode?: 'always' | 'on-low-score'
  /** Threshold below which LLM reflection triggers in 'on-low-score' mode. Default: 0.6. */
  llmThreshold?: number
}

/** Full reflection score returned by `RunReflector.score()`. */
export interface ReflectionScore {
  /** Overall quality score 0-1 */
  overall: number
  /** Individual dimension scores */
  dimensions: ReflectionDimensions
  /** Flags for notable patterns */
  flags: string[]
}

/** Parsed result from LLM reflection scoring. */
interface LlmReflectionResult {
  completeness: number
  coherence: number
  relevance: number
  reasoning: string
}

/** Input data required for scoring a run. */
export interface ReflectionInput {
  /** The original input to the agent (string, object, etc.) */
  input: unknown
  /** The agent's output (string, object, etc.) */
  output: unknown
  /** Tool call results from the run */
  toolCalls?: Array<{ name: string; success: boolean; durationMs?: number }>
  /** Token usage for the run */
  tokenUsage?: { input: number; output: number }
  /** Total wall-clock duration of the run in milliseconds */
  durationMs: number
  /** Number of errors encountered during the run */
  errorCount?: number
  /** Number of retries that occurred during the run */
  retryCount?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dimension weights for the overall score (must sum to 1.0). */
const WEIGHTS: Record<keyof ReflectionDimensions, number> = {
  completeness: 0.3,
  coherence: 0.2,
  toolSuccess: 0.2,
  conciseness: 0.1,
  reliability: 0.2,
}

/** Output length thresholds. */
const VERY_LONG_OUTPUT_CHARS = 10_000
const VERY_SHORT_OUTPUT_CHARS = 5
const IDEAL_OUTPUT_RATIO_MAX = 20

/** Duration thresholds. */
const VERY_FAST_MS = 500

/** Penalty constants. */
const ERROR_PENALTY = 0.2
const RETRY_PENALTY = 0.1

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stringify an unknown value into a string for length measurement. */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Clamp a number between 0 and 1. */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Check if a string looks like valid JSON. */
function isJsonParseable(s: string): boolean {
  const trimmed = s.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed)
      return true
    } catch {
      return false
    }
  }
  return false
}

/** Detect common truncation markers in output text. */
function hasTruncationMarkers(s: string): boolean {
  const lower = s.toLowerCase()
  const tail = lower.slice(-100)
  return (
    tail.includes('...') && tail.endsWith('...') ||
    tail.includes('[truncated]') ||
    tail.includes('[cut off]') ||
    tail.includes('<!-- truncated')
  )
}

// ---------------------------------------------------------------------------
// RunReflector
// ---------------------------------------------------------------------------

/**
 * Scores the quality of an agent run using lightweight heuristics,
 * optionally enhanced with LLM-powered reflection.
 *
 * Stateless — each call to `score()` is independent.
 *
 * ```ts
 * // Heuristic-only (default, zero LLM overhead)
 * const reflector = new RunReflector()
 * const score = await reflector.score({
 *   input: 'Summarize the document',
 *   output: 'Here is the summary...',
 *   toolCalls: [{ name: 'readFile', success: true, durationMs: 120 }],
 *   durationMs: 3200,
 * })
 *
 * // With LLM reflection on low scores
 * const reflectorWithLlm = new RunReflector({
 *   llm: (prompt) => callMyModel(prompt),
 *   llmMode: 'on-low-score',
 *   llmThreshold: 0.6,
 * })
 * ```
 */
export class RunReflector {
  private readonly config: ReflectorConfig | undefined

  constructor(config?: ReflectorConfig) {
    this.config = config
  }

  /**
   * Score a completed agent run.
   *
   * Computes heuristic scores first; optionally enhances with LLM scoring
   * based on the configured mode.
   */
  async score(input: ReflectionInput): Promise<ReflectionScore> {
    const heuristicResult = this.scoreHeuristic(input)

    // If no LLM configured, return heuristic-only
    if (!this.config?.llm) {
      return heuristicResult
    }

    const mode = this.config.llmMode ?? 'on-low-score'
    const threshold = this.config.llmThreshold ?? 0.6

    // Determine if we should invoke LLM
    const shouldInvokeLlm =
      mode === 'always' || heuristicResult.overall < threshold

    if (!shouldInvokeLlm) {
      return heuristicResult
    }

    // Invoke LLM reflection and merge results
    try {
      const llmResult = await this.scoreLlm(input)
      return this.mergeScores(heuristicResult, llmResult)
    } catch {
      // LLM failure: fall back to heuristic with flag
      return {
        ...heuristicResult,
        flags: [...heuristicResult.flags, 'llm_reflection_failed'],
      }
    }
  }

  /**
   * Compute heuristic-only score (synchronous, zero LLM overhead).
   */
  scoreHeuristic(input: ReflectionInput): ReflectionScore {
    const flags: string[] = []

    const inputStr = stringify(input.input)
    const outputStr = stringify(input.output)

    const completeness = this.scoreCompleteness(inputStr, outputStr, flags)
    const coherence = this.scoreCoherence(outputStr, flags)
    const toolSuccess = this.scoreToolSuccess(input.toolCalls, flags)
    const conciseness = this.scoreConciseness(inputStr, outputStr, flags)
    const reliability = this.scoreReliability(
      input.errorCount ?? 0,
      input.retryCount ?? 0,
      flags,
    )

    // Duration flags (informational, don't affect scores)
    if (input.durationMs < VERY_FAST_MS) {
      flags.push('very_fast')
    }

    const dimensions: ReflectionDimensions = {
      completeness,
      coherence,
      toolSuccess,
      conciseness,
      reliability,
    }

    const overall = clamp01(
      WEIGHTS.completeness * completeness +
      WEIGHTS.coherence * coherence +
      WEIGHTS.toolSuccess * toolSuccess +
      WEIGHTS.conciseness * conciseness +
      WEIGHTS.reliability * reliability,
    )

    return { overall, dimensions, flags }
  }

  // ---- LLM reflection -----------------------------------------------------

  /** LLM reflection dimension names. */
  private static readonly LLM_DIMENSIONS = [
    'completeness',
    'coherence',
    'relevance',
  ] as const

  /**
   * Build the prompt for LLM reflection scoring.
   */
  private buildLlmPrompt(input: ReflectionInput): string {
    const inputStr = stringify(input.input)
    const outputStr = stringify(input.output)

    const toolSummary = input.toolCalls
      ? input.toolCalls
          .map(
            (tc) =>
              `  - ${tc.name}: ${tc.success ? 'success' : 'failed'}${tc.durationMs !== undefined ? ` (${tc.durationMs}ms)` : ''}`,
          )
          .join('\n')
      : '  (none)'

    return (
      `You are an expert evaluator. Score the following agent run on 3 dimensions, each from 0.0 to 1.0.\n` +
      `Return ONLY a JSON object matching this schema:\n` +
      `{ "completeness": number, "coherence": number, "relevance": number, "reasoning": string }\n\n` +
      `Dimensions:\n` +
      `- completeness (0.0-1.0): Does the output fully address all parts of the input?\n` +
      `- coherence (0.0-1.0): Is the output well-structured and internally consistent?\n` +
      `- relevance (0.0-1.0): Is the output relevant to the input without unnecessary content?\n\n` +
      `Input: ${inputStr}\n\n` +
      `Output: ${outputStr}\n\n` +
      `Tool calls:\n${toolSummary}\n\n` +
      `Errors: ${input.errorCount ?? 0}, Retries: ${input.retryCount ?? 0}, Duration: ${input.durationMs}ms`
    )
  }

  /** Parsed LLM reflection response. */
  private parseLlmResponse(raw: string): LlmReflectionResult | null {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch {
      return null
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }

    const obj = parsed as Record<string, unknown>

    // Validate required dimension fields
    for (const dim of RunReflector.LLM_DIMENSIONS) {
      if (typeof obj[dim] !== 'number') {
        return null
      }
    }

    return {
      completeness: clamp01(obj['completeness'] as number),
      coherence: clamp01(obj['coherence'] as number),
      relevance: clamp01(obj['relevance'] as number),
      reasoning: typeof obj['reasoning'] === 'string' ? obj['reasoning'] : '',
    }
  }

  /**
   * Score using LLM reflection. Throws on failure.
   */
  private async scoreLlm(input: ReflectionInput): Promise<LlmReflectionResult> {
    if (!this.config?.llm) {
      throw new Error('RunReflector: llm is not configured — scoreLlm() called without a configured llm function')
    }
    const llm = this.config.llm
    const prompt = this.buildLlmPrompt(input)
    const raw = await llm(prompt)
    const result = this.parseLlmResponse(raw)
    if (result === null) {
      throw new Error('Failed to parse LLM reflection response')
    }
    return result
  }

  /**
   * Merge heuristic and LLM scores.
   *
   * Uses LLM dimensions for completeness/coherence and adds relevance.
   * Keeps heuristic for toolSuccess/reliability/conciseness.
   * Blends overall: 0.6 * llmOverall + 0.4 * heuristicOverall.
   * Preserves all heuristic flags.
   */
  private mergeScores(
    heuristic: ReflectionScore,
    llm: LlmReflectionResult,
  ): ReflectionScore {
    // Compute LLM overall from its 3 dimensions (equal weight)
    const llmOverall = (llm.completeness + llm.coherence + llm.relevance) / 3

    // Merge dimensions: LLM overrides completeness/coherence, keep heuristic for the rest
    const dimensions: ReflectionDimensions = {
      completeness: llm.completeness,
      coherence: llm.coherence,
      toolSuccess: heuristic.dimensions.toolSuccess,
      conciseness: heuristic.dimensions.conciseness,
      reliability: heuristic.dimensions.reliability,
    }

    // Blend overall
    const overall = clamp01(0.6 * llmOverall + 0.4 * heuristic.overall)

    return {
      overall,
      dimensions,
      flags: [...heuristic.flags, 'llm_enhanced'],
    }
  }

  // ---- Dimension scorers --------------------------------------------------

  private scoreCompleteness(
    inputStr: string,
    outputStr: string,
    flags: string[],
  ): number {
    // Empty or null output is a hard fail
    if (outputStr.length === 0) {
      flags.push('empty_output')
      return 0
    }

    // Very short output relative to a non-trivial input is suspicious
    if (outputStr.length < VERY_SHORT_OUTPUT_CHARS && inputStr.length > 20) {
      flags.push('very_short_output')
      return 0.2
    }

    // Reasonable length output — full score
    // A slightly longer output relative to input is fine; we only penalize
    // emptiness/extreme shortness here.  Verbosity is handled by conciseness.
    return 1.0
  }

  private scoreCoherence(outputStr: string, flags: string[]): number {
    if (outputStr.length === 0) return 0

    let score = 1.0

    // Check for truncation
    if (hasTruncationMarkers(outputStr)) {
      flags.push('truncated_output')
      score -= 0.3
    }

    // Bonus for structured (JSON) output — no penalty if not JSON
    if (isJsonParseable(outputStr)) {
      // Already 1.0, structured is good
    }

    // Penalize if the output contains obvious error patterns inline
    const lower = outputStr.toLowerCase()
    if (
      lower.includes('internal server error') ||
      lower.includes('unhandled exception') ||
      lower.includes('stack trace')
    ) {
      flags.push('error_in_output')
      score -= 0.2
    }

    return clamp01(score)
  }

  private scoreToolSuccess(
    toolCalls: ReflectionInput['toolCalls'],
    flags: string[],
  ): number {
    // No tools used — neutral, full score
    if (!toolCalls || toolCalls.length === 0) {
      return 1.0
    }

    const total = toolCalls.length
    const successes = toolCalls.filter(tc => tc.success).length
    const ratio = successes / total

    if (successes === 0) {
      flags.push('all_tools_failed')
    }

    return clamp01(ratio)
  }

  private scoreConciseness(
    inputStr: string,
    outputStr: string,
    flags: string[],
  ): number {
    if (outputStr.length === 0) return 1.0 // emptiness penalized elsewhere

    // Penalize very long outputs
    if (outputStr.length > VERY_LONG_OUTPUT_CHARS) {
      flags.push('very_long_output')
      // Gradual penalty: 10K -> 0.8, 20K -> 0.6, 50K -> 0.2
      const overRatio = outputStr.length / VERY_LONG_OUTPUT_CHARS
      return clamp01(1.0 - (overRatio - 1) * 0.2)
    }

    // Penalize excessive output/input ratio when input is non-trivial
    if (inputStr.length > 10) {
      const ratio = outputStr.length / inputStr.length
      if (ratio > IDEAL_OUTPUT_RATIO_MAX) {
        // Gentle penalty for very high ratios
        const excess = (ratio - IDEAL_OUTPUT_RATIO_MAX) / IDEAL_OUTPUT_RATIO_MAX
        return clamp01(1.0 - excess * 0.3)
      }
    }

    return 1.0
  }

  private scoreReliability(
    errorCount: number,
    retryCount: number,
    flags: string[],
  ): number {
    const penalty = errorCount * ERROR_PENALTY + retryCount * RETRY_PENALTY

    if (retryCount >= 3) {
      flags.push('excessive_retries')
    }

    return clamp01(1.0 - penalty)
  }
}
