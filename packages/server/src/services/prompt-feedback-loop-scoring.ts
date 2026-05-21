/**
 * PromptFeedbackLoop scoring helpers — pure functions.
 *
 * Reads run logs, extracts prompts, derives input/output, and converts
 * scorer breakdowns into the optimizer's `failures` format.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runLogRoot } from '@dzupagent/agent-adapters'
import type { AgentEvent } from '@dzupagent/agent-adapters'
import { parseJsonl } from '@dzupagent/core'

import type { ScorerBreakdownEntry } from './prompt-feedback-loop-types.js'

export async function readNormalizedEvents(projectDir: string, runId: string): Promise<AgentEvent[]> {
  const filePath = join(runLogRoot(projectDir, runId), 'normalized-events.jsonl')
  const raw = await readFile(filePath, 'utf8')
  return parseJsonl<AgentEvent>(raw)
}

// Re-exported for backward compatibility with any external consumer importing
// `parseJsonl` from this module. Prefer importing directly from
// `@dzupagent/core` going forward.
export { parseJsonl }

/**
 * Extract unique prompt strings from run events. Currently looks at
 * `adapter:started.prompt`; extend here if additional event shapes carry
 * system prompts in the future (e.g. `adapter:system_prompt`).
 */
export function extractPrompts(events: AgentEvent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const event of events) {
    if (event.type === 'adapter:started' && typeof event.prompt === 'string') {
      const prompt = event.prompt.trim()
      if (prompt.length === 0) continue
      if (seen.has(prompt)) continue
      seen.add(prompt)
      out.push(prompt)
    }
  }
  return out
}

export function deriveInput(events: AgentEvent[]): string {
  for (const event of events) {
    if (event.type === 'adapter:started' && typeof event.prompt === 'string' && event.prompt.length > 0) {
      return event.prompt
    }
  }
  return ''
}

export function deriveOutput(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && event.type === 'adapter:completed' && typeof event.result === 'string') {
      return event.result
    }
  }
  const chunks: string[] = []
  for (const event of events) {
    if (event.type === 'adapter:message' && typeof event.content === 'string') {
      chunks.push(event.content)
    } else if (event.type === 'adapter:stream_delta' && typeof event.content === 'string') {
      chunks.push(event.content)
    }
  }
  return chunks.join('')
}

/**
 * Convert the scored run's per-scorer reasoning into the `failures` format
 * that `PromptOptimizer.optimize()` consumes.
 */
export function toFailureFeedback(
  input: string,
  output: string,
  scorerBreakdown: readonly ScorerBreakdownEntry[],
): Array<{ input: string; output: string; feedback: string }> {
  const failedScorers = scorerBreakdown.filter((s) => !s.pass)
  if (failedScorers.length === 0) {
    // No per-scorer failures but the run was poor overall — still forward a
    // summary so the meta-model has context.
    if (scorerBreakdown.length === 0) return []
    const feedback = scorerBreakdown
      .map((s) => `${s.scorerName}: ${s.score.toFixed(3)} - ${s.reasoning}`)
      .join('; ')
    return [{ input, output, feedback }]
  }

  return failedScorers.map((s) => ({
    input,
    output,
    feedback: `${s.scorerName}: ${s.score.toFixed(3)} - ${s.reasoning}`,
  }))
}
