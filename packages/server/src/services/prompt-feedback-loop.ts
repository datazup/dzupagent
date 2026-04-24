/**
 * PromptFeedbackLoop — Step 2 of the closed-loop self-improvement system.
 *
 * Subscribes to `run:scored` events on a `DzupEventBus`, filters on poor-
 * performing runs, extracts the prompts that were used from the persisted
 * run events (`normalized-events.jsonl` / `raw-events.jsonl`), and invokes
 * `PromptOptimizer` with the scorer feedback attached as failures.
 *
 * When the optimizer returns a version whose `scoreImprovement` meets the
 * configured `autoPublishDelta`, the loop activates (auto-publishes) the
 * improved version. Otherwise the original active version is restored so
 * the improvement lands as a candidate only — never silently shipping a
 * regression.
 *
 * Design notes
 * ------------
 * - Purely event-driven: no polling, no direct coupling to run lifecycle.
 * - Stateless between events — all persistence is delegated to
 *   `PromptVersionStore`. The loop itself only tracks live optimizations
 *   to prevent duplicate work on retried events.
 * - Best-effort: any failure surfaces via `onError` (defaults to stderr)
 *   and never throws out of the event handler — a single bad run must not
 *   break the subscription for the entire process.
 * - Prompt-key derivation is a stable hash of prompt content so that
 *   repeated poor runs with the same system prompt accumulate into a
 *   single version history rather than a new key per run.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DzupEvent, DzupEventBus } from '@dzupagent/core'
import type { EvalDatasetLike } from '@dzupagent/eval-contracts'
import { runLogRoot } from '@dzupagent/agent-adapters'
import type { AgentEvent } from '@dzupagent/agent-adapters'

/**
 * Minimal structural shape of @dzupagent/evals `PromptOptimizer`. Declared
 * locally so the server package does not take a runtime dependency on evals
 * (MC-A02 layer-inversion fix). Hosts that want the feedback loop construct
 * a real `PromptOptimizer` from `@dzupagent/evals` and pass it via config.
 */
export interface PromptOptimizerLike {
  optimize(input: {
    promptKey: string
    dataset: EvalDatasetLike
    failures: Array<{ input: string; output: string; feedback: string }>
  }): Promise<OptimizationResultLike>
}

export interface OptimizationCandidateLike {
  prompt: string
  score: number
}

export interface PromptVersionLike {
  id: string
  promptKey: string
  content: string
  active?: boolean | undefined
  metadata?: Record<string, unknown> | undefined
  createdAt?: string | undefined
}

export interface OptimizationResultLike {
  baselineScore: number
  bestCandidate: OptimizationCandidateLike | null
  candidates: OptimizationCandidateLike[]
  iterations: number
  /** True when the optimizer produced a better version than the original. */
  improved: boolean
  /** Version the optimizer considered best after its round. */
  bestVersion: PromptVersionLike
  /** Version the optimizer was seeded with (baseline). */
  originalVersion: PromptVersionLike
  /** `bestVersion.score - originalVersion.score`. */
  scoreImprovement: number
}

export interface PromptVersionStoreLike {
  getLatest(key: string): Promise<PromptVersionLike | null>
  getActive(key: string): Promise<PromptVersionLike | null>
  save(input: {
    promptKey: string
    content: string
    metadata?: Record<string, unknown> | undefined
    active?: boolean | undefined
  }): Promise<PromptVersionLike>
  activate(versionId: string): Promise<PromptVersionLike>
  list(key: string): Promise<PromptVersionLike[]>
}

// Backward-compat type aliases for the older names used within this module.
// These were previously imported from @dzupagent/evals.
type OptimizationResult = OptimizationResultLike
type PromptOptimizer = PromptOptimizerLike
type PromptVersion = PromptVersionLike
type PromptVersionStore = PromptVersionStoreLike

// ---------------------------------------------------------------------------
// Public config / types
// ---------------------------------------------------------------------------

type RunScoredEvent = Extract<DzupEvent, { type: 'run:scored' }>
type ScorerBreakdownEntry = RunScoredEvent['scorerBreakdown'][number]

export interface PromptFeedbackLoopConfig {
  /** Event bus to subscribe to `run:scored` events on. */
  eventBus: DzupEventBus
  /** Preconfigured optimizer — owns its own meta/eval models + scorers. */
  promptOptimizer: PromptOptimizer
  /** Version store used to seed baseline prompts and publish improvements. */
  promptVersionStore: PromptVersionStore
  /** Root directory where `.dzupagent/runs/<runId>/` lives (same as RunOutcomeAnalyzer). */
  projectDir: string
  /** Score threshold below which a run triggers optimization. Default: 0.7. */
  poorRunThreshold?: number
  /**
   * Minimum improvement delta required to auto-publish (activate) a rewritten
   * prompt. Default: 0.05. Set to `Infinity` to disable auto-publish entirely.
   */
  autoPublishDelta?: number
  /**
   * Optional prefix/namespace for auto-derived prompt keys. Defaults to
   * `run-prompt`, producing keys like `run-prompt:<sha1-12>`.
   */
  promptKeyPrefix?: string
  /**
   * Optional sink for soft-failures. Receives a short error message and the
   * `runId` so hosts can surface it in their own logs. Defaults to a stderr
   * warning.
   */
  onError?: (runId: string, message: string) => void
  /**
   * Factory that constructs an `EvalDatasetLike` from a single (input, output)
   * sample so the optimizer can re-evaluate candidate prompts. Defaults to a
   * minimal inline implementation; hosts may pass
   * `(entries, meta) => EvalDataset.from(entries, meta)` from `@dzupagent/evals`
   * to use the canonical implementation.
   */
  datasetFactory?: (
    entries: ReadonlyArray<{ id: string; input: string; expectedOutput?: string }>,
    meta: { name: string },
  ) => EvalDatasetLike
}

export interface PromptFeedbackProcessResult {
  runId: string
  skipped: boolean
  skipReason?: 'above-threshold' | 'no-prompts' | 'already-processing' | 'not-started'
  promptsProcessed: number
  optimizations: Array<{
    promptKey: string
    optimizationResult: OptimizationResult
    published: boolean
  }>
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export class PromptFeedbackLoop {
  private readonly eventBus: DzupEventBus
  private readonly promptOptimizer: PromptOptimizer
  private readonly promptVersionStore: PromptVersionStore
  private readonly projectDir: string
  private readonly poorRunThreshold: number
  private readonly autoPublishDelta: number
  private readonly promptKeyPrefix: string
  private readonly onError: (runId: string, message: string) => void
  private readonly datasetFactory: NonNullable<PromptFeedbackLoopConfig['datasetFactory']>

  private unsubscribe: (() => void) | null = null
  private readonly inFlight = new Set<string>()

  constructor(config: PromptFeedbackLoopConfig) {
    if (!config.eventBus) {
      throw new Error('PromptFeedbackLoop: eventBus is required')
    }
    if (!config.promptOptimizer) {
      throw new Error('PromptFeedbackLoop: promptOptimizer is required')
    }
    if (!config.promptVersionStore) {
      throw new Error('PromptFeedbackLoop: promptVersionStore is required')
    }
    if (!config.projectDir) {
      throw new Error('PromptFeedbackLoop: projectDir is required')
    }

    this.eventBus = config.eventBus
    this.promptOptimizer = config.promptOptimizer
    this.promptVersionStore = config.promptVersionStore
    this.projectDir = config.projectDir
    this.poorRunThreshold = clamp01(config.poorRunThreshold ?? 0.7)
    // `Infinity` is a legitimate value — it disables auto-publish entirely.
    // Only fall back to the default when the caller supplied `undefined` or a
    // non-numeric value (NaN, etc.).
    this.autoPublishDelta =
      typeof config.autoPublishDelta === 'number' && !Number.isNaN(config.autoPublishDelta)
        ? config.autoPublishDelta
        : 0.05
    this.promptKeyPrefix =
      typeof config.promptKeyPrefix === 'string' && config.promptKeyPrefix.length > 0
        ? config.promptKeyPrefix
        : 'run-prompt'
    this.onError = config.onError ?? defaultOnError
    this.datasetFactory = config.datasetFactory ?? defaultDatasetFactory
  }

  /**
   * Subscribe to `run:scored` events on the bus. Safe to call multiple
   * times — subsequent calls are no-ops while an active subscription is
   * already live.
   */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.eventBus.on('run:scored', (event) => {
      // Fire-and-forget — bus swallows promise rejections, so we handle
      // our own errors here too.
      void this.processRun(event.runId, event.score, event.scorerBreakdown).catch((err) => {
        this.onError(event.runId, `processRun threw: ${stringifyError(err)}`)
      })
    })
  }

  /** Unsubscribe from the bus. No-op when not started. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /**
   * Process a single scored run. Public for testability and for hosts that
   * want to trigger optimization on-demand (e.g. a /rerun endpoint).
   */
  async processRun(
    runId: string,
    score: number,
    scorerBreakdown: readonly ScorerBreakdownEntry[],
  ): Promise<PromptFeedbackProcessResult> {
    if (!runId) {
      this.onError('', 'processRun(): runId is required')
      return {
        runId: '',
        skipped: true,
        skipReason: 'not-started',
        promptsProcessed: 0,
        optimizations: [],
      }
    }

    // Skip anything above (or equal to) the threshold — no optimization needed.
    if (score >= this.poorRunThreshold) {
      return {
        runId,
        skipped: true,
        skipReason: 'above-threshold',
        promptsProcessed: 0,
        optimizations: [],
      }
    }

    // De-dupe concurrent optimizations for the same run (e.g. replayed event).
    if (this.inFlight.has(runId)) {
      return {
        runId,
        skipped: true,
        skipReason: 'already-processing',
        promptsProcessed: 0,
        optimizations: [],
      }
    }
    this.inFlight.add(runId)

    try {
      let events: AgentEvent[] = []
      try {
        events = await readNormalizedEvents(this.projectDir, runId)
      } catch (err) {
        this.onError(runId, `Failed to read normalized-events.jsonl: ${stringifyError(err)}`)
        // Fall through — no events means no prompts, which we handle below.
      }

      const prompts = extractPrompts(events)
      if (prompts.length === 0) {
        return {
          runId,
          skipped: true,
          skipReason: 'no-prompts',
          promptsProcessed: 0,
          optimizations: [],
        }
      }

      const derivedInput = deriveInput(events)
      const derivedOutput = deriveOutput(events)
      const feedback = toFailureFeedback(derivedInput, derivedOutput, scorerBreakdown)

      const optimizations: PromptFeedbackProcessResult['optimizations'] = []

      for (const prompt of prompts) {
        const promptKey = this.derivePromptKey(prompt)
        try {
          const baseline = await this.ensureBaselineVersion(promptKey, prompt)
          const dataset = this.datasetFactory(
            [
              {
                id: `${promptKey}-sample`,
                input: derivedInput,
                expectedOutput: derivedOutput,
              },
            ],
            { name: `feedback-loop:${promptKey}` },
          )

          const optimizationResult = await this.promptOptimizer.optimize({
            promptKey,
            dataset,
            failures: feedback,
          })

          const published = await this.maybePublish(optimizationResult, baseline, runId)

          optimizations.push({ promptKey, optimizationResult, published })
        } catch (err) {
          this.onError(runId, `Optimizer failed for promptKey=${promptKey}: ${stringifyError(err)}`)
        }
      }

      return {
        runId,
        skipped: false,
        promptsProcessed: prompts.length,
        optimizations,
      }
    } finally {
      this.inFlight.delete(runId)
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Ensure an active baseline version exists for the given prompt key. Returns
   * the currently active version after ensuring.
   */
  private async ensureBaselineVersion(
    promptKey: string,
    promptContent: string,
  ): Promise<PromptVersion> {
    const existing = await this.promptVersionStore.getActive(promptKey)
    if (existing) return existing

    return this.promptVersionStore.save({
      promptKey,
      content: promptContent,
      metadata: { source: 'prompt-feedback-loop-baseline' },
      active: true,
    })
  }

  /**
   * Apply the auto-publish policy. Returns `true` when the improved version
   * is left active, `false` when we reverted to the original baseline.
   */
  private async maybePublish(
    result: OptimizationResult,
    baseline: PromptVersion,
    runId: string,
  ): Promise<boolean> {
    if (!result.improved || result.bestVersion.id === result.originalVersion.id) {
      return false
    }

    if (result.scoreImprovement >= this.autoPublishDelta) {
      // The optimizer internally activates its best version at the end of a
      // successful round, so re-activating here is idempotent. We still call
      // it to enforce the publish invariant even when the optimizer was a
      // no-op (e.g. stub in tests). Failures are logged but do not flip the
      // published flag — the intent was to publish, and the optimizer's own
      // activation already landed on disk.
      try {
        await this.promptVersionStore.activate(result.bestVersion.id)
      } catch (err) {
        this.onError(runId, `Failed to re-activate version ${result.bestVersion.id}: ${stringifyError(err)}`)
      }
      return true
    }

    // Not enough improvement — restore the baseline so we don't accidentally
    // leave an unvetted candidate active (the optimizer internally activates
    // the best candidate at the end of a successful round).
    try {
      await this.promptVersionStore.activate(baseline.id)
    } catch (err) {
      this.onError(runId, `Failed to restore baseline ${baseline.id}: ${stringifyError(err)}`)
    }
    return false
  }

  private derivePromptKey(prompt: string): string {
    const hash = createHash('sha1').update(prompt).digest('hex').slice(0, 12)
    return `${this.promptKeyPrefix}:${hash}`
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure, exported for tests via re-export below)
// ---------------------------------------------------------------------------

async function readNormalizedEvents(projectDir: string, runId: string): Promise<AgentEvent[]> {
  const filePath = join(runLogRoot(projectDir, runId), 'normalized-events.jsonl')
  const raw = await readFile(filePath, 'utf8')
  return parseJsonl<AgentEvent>(raw)
}

function parseJsonl<T>(raw: string): T[] {
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // Skip malformed lines.
    }
  }
  return out
}

/**
 * Extract unique prompt strings from run events. Currently looks at
 * `adapter:started.prompt`; extend here if additional event shapes carry
 * system prompts in the future (e.g. `adapter:system_prompt`).
 */
function extractPrompts(events: AgentEvent[]): string[] {
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

function deriveInput(events: AgentEvent[]): string {
  for (const event of events) {
    if (event.type === 'adapter:started' && typeof event.prompt === 'string' && event.prompt.length > 0) {
      return event.prompt
    }
  }
  return ''
}

function deriveOutput(events: AgentEvent[]): string {
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
function toFailureFeedback(
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

/**
 * Default `EvalDatasetLike` implementation used when the host does not supply
 * `datasetFactory`. Implements the minimal surface the loop needs (entries +
 * metadata). Hosts that want the canonical `EvalDataset` from
 * `@dzupagent/evals` should pass it via config.
 */
function defaultDatasetFactory(
  entries: ReadonlyArray<{ id: string; input: string; expectedOutput?: string }>,
  meta: { name: string },
): EvalDatasetLike {
  const frozen = entries.map((e) => {
    const entry: { id: string; input: string; expectedOutput?: string } = {
      id: e.id,
      input: e.input,
    }
    if (e.expectedOutput !== undefined) entry.expectedOutput = e.expectedOutput
    return entry
  })
  return {
    metadata: {
      name: meta.name,
      totalEntries: frozen.length,
      tags: [],
    },
    entries(): ReadonlyArray<{ id: string; input: string; expectedOutput?: string | undefined }> {
      return frozen
    },
    size(): number {
      return frozen.length
    },
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

function defaultOnError(runId: string, message: string): void {
  const prefix = runId ? `[PromptFeedbackLoop] run=${runId}` : '[PromptFeedbackLoop]'
  process.stderr.write(`${prefix} ${message}\n`)
}
