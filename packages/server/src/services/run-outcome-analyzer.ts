/**
 * RunOutcomeAnalyzer — Step 1 of the closed-loop self-improvement system.
 *
 * Reads run events from a `RunEventStore`-backed directory, derives an output
 * + summary metrics, runs the configured `EvalScorer`s from `@dzupagent/evals`,
 * and emits a `run:scored` event on the injected `DzupEventBus`.
 *
 * Design notes
 * ------------
 * - The analyzer is intentionally decoupled from the live event stream: it
 *   operates on the persisted JSONL files written by `RunEventStore`
 *   (`raw-events.jsonl`, `normalized-events.jsonl`, optional `summary.json`).
 *   This mirrors the `RunEventStore` contract and makes the analyzer usable
 *   for both live run completion AND post-hoc re-scoring.
 * - Scoring is best-effort: any failure (missing files, scorer error, etc.)
 *   is swallowed and surfaces via `onError` (defaults to a stderr warning).
 * - The analyzer does NOT depend on any domain package — it only consumes
 *   framework types (`@dzupagent/core`, `@dzupagent/evals`,
 *   `@dzupagent/agent-adapters`).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DzupEventBus } from '@dzupagent/core'
import type { EvalScorer, EvalResult } from '@dzupagent/eval-contracts'
import { runLogRoot } from '@dzupagent/agent-adapters'
import type { AgentEvent, RunSummary } from '@dzupagent/agent-adapters'

// ---------------------------------------------------------------------------
// Public config / types
// ---------------------------------------------------------------------------

export interface RunOutcomeAnalyzerConfig {
  /** Event bus used to emit `run:scored`. */
  eventBus: DzupEventBus
  /** One or more eval scorers — the weighted average becomes the final score. */
  scorers: ReadonlyArray<{ scorer: EvalScorer; weight?: number }>
  /** Root directory where `.dzupagent/runs/<runId>/` lives. */
  projectDir: string
  /**
   * Pass threshold for the aggregate score — the run is flagged `passed` when
   * `score >= passThreshold`. Defaults to `0.7` (matches `EvalSuite.passThreshold`).
   */
  passThreshold?: number
  /**
   * Optional sink for soft-failures. Receives a short error message and the
   * `runId` so hosts can surface it in their own logs. Defaults to a
   * stderr warning.
   */
  onError?: (runId: string, message: string) => void
}

export interface AnalyzeOptions {
  /** Agent identifier — propagated onto the emitted event. */
  agentId?: string
  /**
   * Explicit input/output/reference override. When omitted the analyzer
   * derives them from the persisted events + summary.
   */
  input?: string
  output?: string
  reference?: string
}

export interface RunOutcomeAnalysis {
  runId: string
  score: number
  passed: boolean
  scorerBreakdown: Array<{
    scorerName: string
    score: number
    pass: boolean
    reasoning: string
  }>
  metrics: {
    totalEvents: number
    toolCalls: number
    toolErrors: number
    errors: number
    durationMs?: number
  }
  scoredAt: number
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export class RunOutcomeAnalyzer {
  private readonly eventBus: DzupEventBus
  private readonly scorers: ReadonlyArray<{ scorer: EvalScorer; weight: number }>
  private readonly projectDir: string
  private readonly passThreshold: number
  private readonly onError: (runId: string, message: string) => void

  constructor(config: RunOutcomeAnalyzerConfig) {
    if (!config.eventBus) {
      throw new Error('RunOutcomeAnalyzer: eventBus is required')
    }
    if (!config.scorers || config.scorers.length === 0) {
      throw new Error('RunOutcomeAnalyzer: at least one scorer is required')
    }
    if (!config.projectDir) {
      throw new Error('RunOutcomeAnalyzer: projectDir is required')
    }

    this.eventBus = config.eventBus
    this.scorers = config.scorers.map(({ scorer, weight }) => ({
      scorer,
      weight: typeof weight === 'number' && weight > 0 ? weight : 1,
    }))
    this.projectDir = config.projectDir
    this.passThreshold = clamp01(config.passThreshold ?? 0.7)
    this.onError = config.onError ?? defaultOnError
  }

  /**
   * Score the given run and emit `run:scored`. Returns the computed analysis,
   * or `null` when an unrecoverable error prevented scoring (already surfaced
   * via `onError`).
   */
  async analyze(runId: string, options: AnalyzeOptions = {}): Promise<RunOutcomeAnalysis | null> {
    if (!runId) {
      this.onError('', 'analyze(): runId is required')
      return null
    }

    let events: AgentEvent[] = []
    let summary: RunSummary | null = null
    try {
      events = await readNormalizedEvents(this.projectDir, runId)
    } catch (err) {
      this.onError(runId, `Failed to read normalized-events.jsonl: ${stringifyError(err)}`)
      // Continue — we can still score with whatever was supplied via options.
    }

    try {
      summary = await readRunSummary(this.projectDir, runId)
    } catch (err) {
      this.onError(runId, `Failed to read summary.json: ${stringifyError(err)}`)
      // Continue — summary is optional.
    }

    const metrics = deriveMetrics(events, summary)
    const derivedInput = options.input ?? deriveInput(events)
    const derivedOutput = options.output ?? deriveOutput(events, summary)

    // Run every scorer — individual failures degrade gracefully to a 0 score.
    const scorerResults = await Promise.all(
      this.scorers.map(async ({ scorer, weight }) => {
        const result = await safeScore(scorer, derivedInput, derivedOutput, options.reference, (msg) =>
          this.onError(runId, msg),
        )
        return { scorer, weight, result }
      }),
    )

    const totalWeight = scorerResults.reduce((sum, r) => sum + r.weight, 0)
    const score =
      totalWeight > 0
        ? clamp01(
            scorerResults.reduce(
              (sum, r) => sum + (r.result.score * r.weight) / totalWeight,
              0,
            ),
          )
        : 0

    const passed = score >= this.passThreshold

    const scorerBreakdown = scorerResults.map((r) => ({
      scorerName: r.scorer.name,
      score: r.result.score,
      pass: r.result.pass,
      reasoning: r.result.reasoning,
    }))

    const scoredAt = Date.now()
    const analysis: RunOutcomeAnalysis = {
      runId,
      score,
      passed,
      scorerBreakdown,
      metrics,
      scoredAt,
    }

    this.eventBus.emit({
      type: 'run:scored',
      runId,
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      score,
      passed,
      scorerBreakdown,
      metrics,
      scoredAt,
    })

    return analysis
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readNormalizedEvents(projectDir: string, runId: string): Promise<AgentEvent[]> {
  const filePath = join(runLogRoot(projectDir, runId), 'normalized-events.jsonl')
  const raw = await readFile(filePath, 'utf8')
  return parseJsonl<AgentEvent>(raw)
}

async function readRunSummary(projectDir: string, runId: string): Promise<RunSummary | null> {
  const filePath = join(runLogRoot(projectDir, runId), 'summary.json')
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as RunSummary
  } catch (err: unknown) {
    // ENOENT is expected when summary was never written (e.g. mid-run).
    if (isNotFound(err)) return null
    throw err
  }
}

function parseJsonl<T>(raw: string): T[] {
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // Skip malformed lines — the store tolerates partial writes on disk errors.
    }
  }
  return out
}

function deriveMetrics(events: AgentEvent[], summary: RunSummary | null): RunOutcomeAnalysis['metrics'] {
  let toolCalls = 0
  let toolErrors = 0
  let errors = 0
  for (const event of events) {
    switch (event.type) {
      case 'adapter:tool_call':
        toolCalls++
        break
      case 'adapter:tool_result':
        // tool_result without errors is a success; nothing to count.
        break
      case 'adapter:failed':
        errors++
        break
      default:
        break
    }
  }
  // Fall back to summary counts when no normalized events are on disk.
  if (events.length === 0 && summary) {
    toolCalls = summary.toolCallCount
    if (summary.status === 'failed') errors = 1
  }

  const durationMs = summary?.durationMs
  return {
    totalEvents: events.length,
    toolCalls,
    toolErrors,
    errors,
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  }
}

function deriveInput(events: AgentEvent[]): string {
  for (const event of events) {
    if (event.type === 'adapter:started' && typeof event.prompt === 'string' && event.prompt.length > 0) {
      return event.prompt
    }
  }
  return ''
}

function deriveOutput(events: AgentEvent[], summary: RunSummary | null): string {
  // Prefer an explicit terminal result captured by `adapter:completed`.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && event.type === 'adapter:completed' && typeof event.result === 'string') {
      return event.result
    }
  }
  // Fall back to the concatenation of assistant messages and stream deltas.
  const chunks: string[] = []
  for (const event of events) {
    if (event.type === 'adapter:message' && typeof event.content === 'string') {
      chunks.push(event.content)
    } else if (event.type === 'adapter:stream_delta' && typeof event.content === 'string') {
      chunks.push(event.content)
    }
  }
  if (chunks.length > 0) return chunks.join('')

  if (summary?.errorMessage) return summary.errorMessage
  return ''
}

async function safeScore(
  scorer: EvalScorer,
  input: string,
  output: string,
  reference: string | undefined,
  onScorerError: (message: string) => void,
): Promise<EvalResult> {
  try {
    return await scorer.score(input, output, reference)
  } catch (err) {
    const msg = stringifyError(err)
    onScorerError(`Scorer "${scorer.name}" threw: ${msg}`)
    return {
      score: 0,
      pass: false,
      reasoning: `Scorer "${scorer.name}" failed: ${msg}`,
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT',
  )
}

function defaultOnError(runId: string, message: string): void {
  const prefix = runId ? `[RunOutcomeAnalyzer] run=${runId}` : '[RunOutcomeAnalyzer]'
  process.stderr.write(`${prefix} ${message}\n`)
}
