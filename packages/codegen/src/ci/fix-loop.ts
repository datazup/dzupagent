/**
 * Fix Loop — orchestrate fix-attempt cycles for CI failures.
 */

import type { CIFailure } from './ci-monitor.js'
import type { FixStrategy } from './failure-router.js'
import { routeFailure } from './failure-router.js'

export interface FixLoopConfig {
  /** Max total fix attempts across all failures (default: 5) */
  maxTotalAttempts: number
  /** Custom strategies override */
  strategies?: Record<string, FixStrategy>
}

export interface FixAttempt {
  failure: CIFailure
  strategy: FixStrategy
  attempt: number
  prompt: string
  /** Whether this attempt fixed the issue (set after CI re-run) */
  success?: boolean
}

export interface FixLoopResult {
  attempts: FixAttempt[]
  allFixed: boolean
  totalAttempts: number
}

const DEFAULT_CONFIG: FixLoopConfig = {
  maxTotalAttempts: 5,
}

/**
 * Build a comprehensive fix prompt from a CI failure and its strategy.
 */
export function buildFixPrompt(failure: CIFailure, strategy: FixStrategy, attempt: number): string {
  const lines: string[] = []

  lines.push(`## CI Fix — Attempt ${attempt}/${strategy.maxAttempts}`)
  lines.push('')
  lines.push(`**Job:** ${failure.jobName}`)
  if (failure.step) {
    lines.push(`**Step:** ${failure.step}`)
  }
  if (failure.exitCode !== undefined) {
    lines.push(`**Exit code:** ${failure.exitCode}`)
  }
  lines.push(`**Category:** ${failure.errorCategory ?? 'unknown'}`)
  lines.push('')
  lines.push('### Instructions')
  lines.push(strategy.promptHint)
  lines.push('')
  lines.push(`**Suggested tools:** ${strategy.suggestedTools.join(', ')}`)
  lines.push('')
  lines.push('### CI Log Excerpt')
  lines.push('```')
  lines.push(failure.logExcerpt)
  lines.push('```')

  if (attempt > 1) {
    lines.push('')
    lines.push(
      `> This is attempt ${attempt}. Previous attempts did not resolve the issue. ` +
        'Try a different approach or look more carefully at the root cause.',
    )
  }

  return lines.join('\n')
}

/**
 * Generate fix attempt prompts for a list of CI failures.
 * Each attempt gets a targeted prompt based on the failure category.
 * Respects maxTotalAttempts across all failures, distributing attempts
 * proportionally to each failure's strategy maxAttempts.
 */
export function generateFixAttempts(
  failures: CIFailure[],
  config?: Partial<FixLoopConfig>,
): FixAttempt[] {
  const resolved: FixLoopConfig = { ...DEFAULT_CONFIG, ...config }
  const attempts: FixAttempt[] = []
  let remaining = resolved.maxTotalAttempts

  for (const failure of failures) {
    if (remaining <= 0) break

    const strategy = routeFailure(failure, resolved.strategies)
    const attemptsForThis = Math.min(strategy.maxAttempts, remaining)

    for (let i = 1; i <= attemptsForThis; i++) {
      attempts.push({
        failure,
        strategy,
        attempt: i,
        prompt: buildFixPrompt(failure, strategy, i),
      })
    }

    remaining -= attemptsForThis
  }

  return attempts
}
