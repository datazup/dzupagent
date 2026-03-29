/**
 * OutputRefinementLoop --- Domain-aware post-generation polishing module.
 *
 * After an agent generates initial output, this module:
 * 1. Runs a domain-aware critique pass (identifies issues specific to the output domain)
 * 2. Applies targeted refinements based on the critique
 * 3. Verifies the refinement didn't introduce regressions
 * 4. Returns the best version (original or refined)
 *
 * Unlike ReflectionLoop (which is open-ended drafter/critic), OutputRefinementLoop is:
 * - **Domain-aware**: critique prompts adapt to SQL, code, analysis, ops domains
 * - **Regression-safe**: compares refined output against original on quality dimensions
 * - **Budget-conscious**: stops early if refinement isn't worth the cost
 * - **Non-destructive**: always returns the better of original vs refined
 *
 * General-purpose --- works for any text generation task. Not specific to code generation.
 *
 * @module self-correction/output-refinement
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported refinement domains. */
export type RefinementDomain = 'sql' | 'code' | 'analysis' | 'ops' | 'general'

/** Configuration for the output refinement loop. */
export interface RefinementConfig {
  /** Max refinement iterations (default: 2). */
  maxIterations: number
  /** Quality threshold --- stop refining if above this (default: 0.9). */
  qualityThreshold: number
  /** Minimum improvement required to accept refinement (default: 0.05). */
  minImprovement: number
  /** Cost budget for refinements in cents (default: 20). */
  costBudgetCents: number
  /** Domain (auto-detected if not specified). */
  domain?: RefinementDomain
}

/** A single refinement iteration record. */
export interface RefinementIteration {
  /** 1-based iteration number. */
  iteration: number
  /** Domain used for critique. */
  domain: RefinementDomain
  /** Critique text from the model. */
  critique: string
  /** Refined output produced in this iteration. */
  refinedOutput: string
  /** Quality score of the original/current best output. */
  originalScore: number
  /** Quality score of the refined output. */
  refinedScore: number
  /** Score improvement (refinedScore - originalScore). */
  improvement: number
  /** Whether this refinement was accepted. */
  accepted: boolean
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

/** Result of the full refinement loop execution. */
export interface RefinementResult {
  /** Best output (original or refined). */
  bestOutput: string
  /** Whether any refinement was accepted. */
  wasRefined: boolean
  /** Quality score of the best output. */
  bestScore: number
  /** Quality score of the original. */
  originalScore: number
  /** Total improvement (bestScore - originalScore). */
  totalImprovement: number
  /** Domain used for critique. */
  domain: RefinementDomain
  /** Refinement history. */
  iterations: RefinementIteration[]
  /** Why refinement stopped. */
  exitReason:
    | 'quality_met'
    | 'max_iterations'
    | 'no_improvement'
    | 'budget_exhausted'
    | 'regression_detected'
    | 'error'
  /** Total duration in milliseconds. */
  totalDurationMs: number
  /** Estimated cost in cents. */
  estimatedCostCents: number
}

/** Scoring function signature. */
export interface ScoreFn {
  (output: string, task: string): Promise<{ score: number; feedback: string }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough chars-per-token ratio for cost estimation. */
const CHARS_PER_TOKEN = 4

/** Cost per 1K tokens in cents ($0.003/1K tokens = 0.3 cents). */
const COST_PER_1K_TOKENS_CENTS = 0.3

// ---------------------------------------------------------------------------
// Domain Critique Prompts
// ---------------------------------------------------------------------------

const DOMAIN_CRITIQUE_PROMPTS: Readonly<Record<RefinementDomain, string>> = {
  sql: `Review this SQL query for:
1. Correctness — does it match the requirements?
2. Efficiency — are there unnecessary subqueries, missing indexes hints, or N+1 patterns?
3. Safety — is it parameterized? Any injection risks?
4. Readability — proper formatting, aliases, comments?
Score 0-1 and provide specific, actionable feedback.

Respond in this exact format:
Score: <number 0.00-1.00>
Feedback: <specific, actionable feedback>`,

  code: `Review this code for:
1. Type safety — any \`any\` types, missing type annotations, unsafe casts?
2. Error handling — are errors properly caught and typed?
3. Security — hardcoded secrets, eval(), unsafe DOM operations?
4. Testing — are there tests? Do they cover edge cases?
Score 0-1 and provide specific, actionable feedback.

Respond in this exact format:
Score: <number 0.00-1.00>
Feedback: <specific, actionable feedback>`,

  analysis: `Review this analysis for:
1. Accuracy — are the conclusions supported by the data?
2. Completeness — are all aspects of the question addressed?
3. Methodology — is the analytical approach sound?
4. Clarity — is the communication clear and well-structured?
Score 0-1 and provide specific, actionable feedback.

Respond in this exact format:
Score: <number 0.00-1.00>
Feedback: <specific, actionable feedback>`,

  ops: `Review this operations task for:
1. Idempotency — can this be safely re-run?
2. Rollback — is there a recovery path if something goes wrong?
3. Permissions — least-privilege principle followed?
4. Monitoring — are there health checks, logging, alerting?
Score 0-1 and provide specific, actionable feedback.

Respond in this exact format:
Score: <number 0.00-1.00>
Feedback: <specific, actionable feedback>`,

  general: `Review this output for:
1. Correctness — does it answer the question?
2. Completeness — are all parts addressed?
3. Quality — is it well-structured and clear?
Score 0-1 and provide specific, actionable feedback.

Respond in this exact format:
Score: <number 0.00-1.00>
Feedback: <specific, actionable feedback>`,
}

const REFINEMENT_SYSTEM_PROMPT = `You are an expert assistant. Refine the output below based on the critique feedback. Address ALL feedback points while maintaining the original task requirements.

Do NOT explain what you changed. Just output the improved version directly.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate token count from character length. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Estimate cost in cents for a given number of tokens (input + output combined). */
function estimateCostCents(totalTokens: number): number {
  return (totalTokens / 1000) * COST_PER_1K_TOKENS_CENTS
}

/** Extract response text from model output. */
function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content)
}

/**
 * Parse a critique response to extract a score (0-1) and feedback text.
 * Looks for "Score: X.XX" pattern. Falls back to a default score of 0.5.
 */
function parseCritiqueResponse(response: string): { score: number; feedback: string } {
  // Try "Score: 0.XX" pattern (0-1 range)
  const scoreMatch01 = response.match(/Score:\s*(0(?:\.\d+)?|1(?:\.0+)?)\b/i)
  if (scoreMatch01) {
    const score = Math.max(0, Math.min(1, parseFloat(scoreMatch01[1]!)))
    const feedbackMatch = response.match(/Feedback:\s*([\s\S]*)/i)
    const feedback = feedbackMatch
      ? feedbackMatch[1]!.trim()
      : response.replace(/Score:\s*[\d.]+/i, '').trim()
    return { score, feedback: feedback || 'No specific feedback provided.' }
  }

  // Try "Score: X" pattern where X could be 0-10 range
  const scoreMatch10 = response.match(/Score:\s*(\d+(?:\.\d+)?)/i)
  if (scoreMatch10) {
    let rawScore = parseFloat(scoreMatch10[1]!)
    // If value > 1, assume 0-10 scale and normalize
    if (rawScore > 1) {
      rawScore = Math.max(0, Math.min(10, rawScore)) / 10
    }
    const feedbackMatch = response.match(/Feedback:\s*([\s\S]*)/i)
    const feedback = feedbackMatch
      ? feedbackMatch[1]!.trim()
      : response.replace(/Score:\s*[\d.]+/i, '').trim()
    return { score: rawScore, feedback: feedback || 'No specific feedback provided.' }
  }

  // Fallback: no score found
  return { score: 0.5, feedback: response.trim() || 'No specific feedback provided.' }
}

// ---------------------------------------------------------------------------
// Domain Detection
// ---------------------------------------------------------------------------

/** SQL keywords for domain detection. */
const SQL_KEYWORDS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE TABLE', 'ALTER TABLE',
  'DROP TABLE', 'JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
  'FROM', 'INTO', 'VALUES', 'SET', 'INDEX', 'UNION',
]

/** Code keywords for domain detection. */
const CODE_KEYWORDS = [
  'function', 'class', 'const ', 'let ', 'var ', 'import ', 'export ',
  'return ', 'if (', 'for (', 'while (', 'async ', 'await ', 'def ',
  'interface ', 'type ', 'enum ', 'struct ', 'impl ', 'fn ',
]

/** Ops keywords for domain detection. */
const OPS_KEYWORDS = [
  'deploy', 'rollback', 'restart', 'scale', 'docker', 'kubernetes',
  'k8s', 'helm', 'terraform', 'ansible', 'pipeline', 'ci/cd',
  'systemctl', 'nginx', 'loadbalancer', 'health check', 'monitoring',
  'alerting', 'chmod', 'chown', 'cron', 'systemd',
]

/** Analysis keywords for domain detection. */
const ANALYSIS_KEYWORDS = [
  'analysis', 'conclusion', 'findings', 'hypothesis', 'methodology',
  'data shows', 'trend', 'correlation', 'significant', 'average',
  'median', 'standard deviation', 'regression', 'metric', 'benchmark',
  'insight', 'recommendation', 'observation', 'evidence',
]

// ---------------------------------------------------------------------------
// OutputRefinementLoop
// ---------------------------------------------------------------------------

/**
 * Domain-aware post-generation polishing loop.
 *
 * ```ts
 * const loop = new OutputRefinementLoop(model, {
 *   maxIterations: 2,
 *   qualityThreshold: 0.9,
 * })
 *
 * const result = await loop.refine({
 *   task: 'Write a query to find top customers...',
 *   output: 'SELECT * FROM customers...',
 * })
 *
 * console.log(result.bestOutput)    // refined output
 * console.log(result.wasRefined)    // true if improved
 * console.log(result.exitReason)    // 'quality_met' | 'max_iterations' | ...
 * ```
 */
export class OutputRefinementLoop {
  private readonly model: BaseChatModel
  private readonly config: RefinementConfig

  constructor(
    model: BaseChatModel,
    config?: Partial<RefinementConfig>,
  ) {
    this.model = model
    this.config = {
      maxIterations: config?.maxIterations ?? 2,
      qualityThreshold: config?.qualityThreshold ?? 0.9,
      minImprovement: config?.minImprovement ?? 0.05,
      costBudgetCents: config?.costBudgetCents ?? 20,
      domain: config?.domain,
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Refine an output with domain-aware critique.
   */
  async refine(params: {
    task: string
    output: string
    /** Optional scoring function (defaults to model self-eval). */
    scoreFn?: ScoreFn
    /** Optional domain override. */
    domain?: RefinementDomain
    /** Optional context for enrichment. */
    context?: Record<string, string>
  }): Promise<RefinementResult> {
    const totalStart = Date.now()
    const iterations: RefinementIteration[] = []
    let accumulatedCostCents = 0

    const domain = params.domain ?? this.config.domain ?? OutputRefinementLoop.detectDomain(params.task, params.output)
    let bestOutput = params.output
    let bestScore = 0
    let exitReason: RefinementResult['exitReason'] = 'max_iterations'

    // --- Score the original output ---
    let originalScore: number
    try {
      const scoreResult = params.scoreFn
        ? await params.scoreFn(params.output, params.task)
        : await this.critiqueAndScore(params.task, params.output, domain, params.context)

      originalScore = scoreResult.score
      bestScore = originalScore

      if (!params.scoreFn) {
        const totalChars = params.task.length + params.output.length + DOMAIN_CRITIQUE_PROMPTS[domain].length + scoreResult.feedback.length
        accumulatedCostCents += estimateCostCents(estimateTokens(totalChars))
      }
    } catch {
      return this.buildResult(bestOutput, false, 0, 0, domain, iterations, 'error', totalStart, accumulatedCostCents)
    }

    // If already above quality threshold, return immediately
    if (originalScore >= this.config.qualityThreshold) {
      return this.buildResult(bestOutput, false, bestScore, originalScore, domain, iterations, 'quality_met', totalStart, accumulatedCostCents)
    }

    // --- Refinement iterations ---
    for (let i = 0; i < this.config.maxIterations; i++) {
      const iterStart = Date.now()

      // Budget check before starting iteration
      if (accumulatedCostCents >= this.config.costBudgetCents) {
        exitReason = 'budget_exhausted'
        break
      }

      // Step 1: Critique the current best output
      let critique: string
      let critiqueScore: number
      try {
        const critiqueResult = params.scoreFn
          ? await params.scoreFn(bestOutput, params.task)
          : await this.critiqueAndScore(params.task, bestOutput, domain, params.context)

        critique = critiqueResult.feedback
        critiqueScore = critiqueResult.score

        if (!params.scoreFn) {
          const totalChars = params.task.length + bestOutput.length + DOMAIN_CRITIQUE_PROMPTS[domain].length + critique.length
          accumulatedCostCents += estimateCostCents(estimateTokens(totalChars))
        }
      } catch {
        exitReason = 'error'
        break
      }

      // Step 2: Refine based on critique
      let refinedOutput: string
      try {
        refinedOutput = await this.applyRefinement(params.task, bestOutput, critique, params.context)

        const refinementChars = params.task.length + bestOutput.length + critique.length + REFINEMENT_SYSTEM_PROMPT.length + refinedOutput.length
        accumulatedCostCents += estimateCostCents(estimateTokens(refinementChars))
      } catch {
        exitReason = 'error'
        break
      }

      // Step 3: Score the refined output
      let refinedScore: number
      try {
        const refinedResult = params.scoreFn
          ? await params.scoreFn(refinedOutput, params.task)
          : await this.critiqueAndScore(params.task, refinedOutput, domain, params.context)

        refinedScore = refinedResult.score

        if (!params.scoreFn) {
          const totalChars = params.task.length + refinedOutput.length + DOMAIN_CRITIQUE_PROMPTS[domain].length + refinedResult.feedback.length
          accumulatedCostCents += estimateCostCents(estimateTokens(totalChars))
        }
      } catch {
        exitReason = 'error'
        break
      }

      const improvement = refinedScore - bestScore
      const accepted = improvement >= this.config.minImprovement

      iterations.push({
        iteration: i + 1,
        domain,
        critique,
        refinedOutput,
        originalScore: bestScore,
        refinedScore,
        improvement,
        accepted,
        durationMs: Date.now() - iterStart,
      })

      // Step 4: Evaluate results

      // Regression detected --- refined output is worse
      if (refinedScore < bestScore) {
        exitReason = 'regression_detected'
        break
      }

      // No meaningful improvement
      if (improvement < this.config.minImprovement) {
        exitReason = 'no_improvement'
        break
      }

      // Accept refinement
      bestOutput = refinedOutput
      bestScore = refinedScore

      // Quality threshold met
      if (bestScore >= this.config.qualityThreshold) {
        exitReason = 'quality_met'
        break
      }

      // Budget check after iteration
      if (accumulatedCostCents >= this.config.costBudgetCents) {
        exitReason = 'budget_exhausted'
        break
      }

      // If this was the last iteration, exit reason stays 'max_iterations'
    }

    const wasRefined = iterations.some(iter => iter.accepted)
    return this.buildResult(bestOutput, wasRefined, bestScore, originalScore, domain, iterations, exitReason, totalStart, accumulatedCostCents)
  }

  /**
   * Auto-detect domain from task and output content.
   * Checks for domain-specific keywords and returns the best match.
   */
  static detectDomain(task: string, output: string): RefinementDomain {
    const combined = `${task}\n${output}`.toUpperCase()

    const scores: Record<RefinementDomain, number> = {
      sql: 0,
      code: 0,
      analysis: 0,
      ops: 0,
      general: 0,
    }

    for (const kw of SQL_KEYWORDS) {
      if (combined.includes(kw.toUpperCase())) scores.sql++
    }

    for (const kw of CODE_KEYWORDS) {
      if (combined.includes(kw.toUpperCase())) scores.code++
    }

    for (const kw of OPS_KEYWORDS) {
      if (combined.includes(kw.toUpperCase())) scores.ops++
    }

    for (const kw of ANALYSIS_KEYWORDS) {
      if (combined.includes(kw.toUpperCase())) scores.analysis++
    }

    // Find the domain with the highest score
    let bestDomain: RefinementDomain = 'general'
    let bestCount = 0

    for (const [domain, count] of Object.entries(scores)) {
      if (domain === 'general') continue
      if (count > bestCount) {
        bestCount = count
        bestDomain = domain as RefinementDomain
      }
    }

    // Require at least 2 keyword matches to assign a specific domain
    if (bestCount < 2) {
      return 'general'
    }

    return bestDomain
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Run a domain-aware critique on the output, returning score and feedback.
   */
  private async critiqueAndScore(
    task: string,
    output: string,
    domain: RefinementDomain,
    context?: Record<string, string>,
  ): Promise<{ score: number; feedback: string }> {
    const systemPrompt = DOMAIN_CRITIQUE_PROMPTS[domain]

    let userContent = `## Task\n${task}\n\n## Output to Review\n${output}`

    if (context && Object.keys(context).length > 0) {
      const contextLines = Object.entries(context)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n')
      userContent += `\n\n## Additional Context\n${contextLines}`
    }

    const response = await this.model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userContent),
    ])

    const responseText = extractText(response.content as string | Array<{ type: string; text?: string }>)
    return parseCritiqueResponse(responseText)
  }

  /**
   * Apply refinement based on critique feedback.
   */
  private async applyRefinement(
    task: string,
    currentOutput: string,
    critique: string,
    context?: Record<string, string>,
  ): Promise<string> {
    let userContent = `## Original Task\n${task}\n\n## Current Output\n${currentOutput}\n\n## Critique Feedback\n${critique}`

    if (context && Object.keys(context).length > 0) {
      const contextLines = Object.entries(context)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n')
      userContent += `\n\n## Additional Context\n${contextLines}`
    }

    const response = await this.model.invoke([
      new SystemMessage(REFINEMENT_SYSTEM_PROMPT),
      new HumanMessage(userContent),
    ])

    return extractText(response.content as string | Array<{ type: string; text?: string }>)
  }

  /**
   * Build a RefinementResult from accumulated state.
   */
  private buildResult(
    bestOutput: string,
    wasRefined: boolean,
    bestScore: number,
    originalScore: number,
    domain: RefinementDomain,
    iterations: RefinementIteration[],
    exitReason: RefinementResult['exitReason'],
    totalStart: number,
    estimatedCostCents: number,
  ): RefinementResult {
    return {
      bestOutput,
      wasRefined,
      bestScore,
      originalScore,
      totalImprovement: bestScore - originalScore,
      domain,
      iterations,
      exitReason,
      totalDurationMs: Date.now() - totalStart,
      estimatedCostCents: Math.round(estimatedCostCents * 100) / 100,
    }
  }
}
