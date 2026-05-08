/**
 * Domain critique prompts, refinement system prompt, parsing helpers,
 * cost estimation, and domain auto-detection for OutputRefinementLoop.
 *
 * @module self-correction/output-refinement-prompts
 */

import type { RefinementDomain } from './output-refinement-types.js'

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

export const DOMAIN_CRITIQUE_PROMPTS: Readonly<Record<RefinementDomain, string>> = {
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

export const REFINEMENT_SYSTEM_PROMPT = `You are an expert assistant. Refine the output below based on the critique feedback. Address ALL feedback points while maintaining the original task requirements.

Do NOT explain what you changed. Just output the improved version directly.`

// ---------------------------------------------------------------------------
// Cost / token helpers
// ---------------------------------------------------------------------------

/** Estimate token count from character length. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Estimate cost in cents for a given number of tokens (input + output combined). */
export function estimateCostCents(totalTokens: number): number {
  return (totalTokens / 1000) * COST_PER_1K_TOKENS_CENTS
}

/** Extract response text from model output. */
export function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content)
}

/**
 * Parse a critique response to extract a score (0-1) and feedback text.
 * Looks for "Score: X.XX" pattern. Falls back to a default score of 0.5.
 */
export function parseCritiqueResponse(response: string): { score: number; feedback: string } {
  // Try "Score: 0.XX" pattern (0-1 range)
  const scoreMatch01 = response.match(/Score:\s*(0(?:\.\d+)?|1(?:\.0+)?)\b/i) // eslint-disable-line security/detect-unsafe-regex -- fixed literal extracting bounded decimal from LLM text; no external input drives the pattern
  if (scoreMatch01) {
    const score = Math.max(0, Math.min(1, parseFloat(scoreMatch01[1]!)))
    const feedbackMatch = response.match(/Feedback:\s*([\s\S]*)/i)
    const feedback = feedbackMatch
      ? feedbackMatch[1]!.trim()
      : response.replace(/Score:\s*[\d.]+/i, '').trim()
    return { score, feedback: feedback || 'No specific feedback provided.' }
  }

  // Try "Score: X" pattern where X could be 0-10 range
  const scoreMatch10 = response.match(/Score:\s*(\d+(?:\.\d+)?)/i) // eslint-disable-line security/detect-unsafe-regex -- fixed literal extracting bounded decimal from LLM text; no external input drives the pattern
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

/**
 * Auto-detect domain from task and output content.
 * Checks for domain-specific keywords and returns the best match.
 * Requires at least 2 keyword matches to assign a specific domain;
 * otherwise falls back to 'general'.
 */
export function detectRefinementDomain(task: string, output: string): RefinementDomain {
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
