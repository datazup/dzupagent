/**
 * LearningEventProcessor — Step 3 of the closed-loop self-improvement system.
 *
 * Subscribes to `run:scored` events on the injected `DzupEventBus`, heuristically
 * extracts generalizable patterns from the scored run's context, and persists
 * them as memory items via `MemoryServiceLike`. Persisted items carry full
 * provenance (runId, score, agentId) and decay metadata (ttlMs/expiresAt) so
 * downstream decay jobs can prune stale entries.
 *
 * Design notes
 * ------------
 * - The processor is event-driven and stateless — `start()` installs a single
 *   subscription on the bus, `stop()` removes it.
 * - Pattern extraction is a conservative heuristic that operates only on the
 *   `run:scored` payload: scorer breakdowns, metrics, and outcome status. When
 *   the host application has richer context (e.g. tool outputs) it should
 *   call `POST /api/learning/ingest` directly with pre-computed patterns.
 * - All memory failures are swallowed and surfaced via `onError` to avoid
 *   breaking the event loop.
 */

import type { DzupEventBus, DzupEventOf } from '@dzupagent/core'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

import {
  storeLearningPattern,
  type LearningPattern,
} from '../routes/learning.js'

// ---------------------------------------------------------------------------
// Public config / types
// ---------------------------------------------------------------------------

export interface LearningEventProcessorConfig {
  /** Event bus to subscribe to `run:scored` on. */
  eventBus: DzupEventBus
  /** Memory service used to persist extracted patterns. */
  memoryService: MemoryServiceLike
  /** Tenant scope for stored memory items. Defaults to `'default'`. */
  tenantId?: string
  /** Minimum confidence for persistence. Defaults to `0.5`. */
  confidenceThreshold?: number
  /** TTL (ms) applied to each stored pattern. Defaults to 30 days. */
  ttlMs?: number
  /**
   * Minimum aggregate run score required before the processor attempts to
   * extract patterns. Defaults to `0.7` (matches the RunOutcomeAnalyzer
   * passThreshold). Runs below this score still contribute `failure` patterns.
   */
  successScoreThreshold?: number
  /** Optional error sink — defaults to a stderr warning. */
  onError?: (runId: string, message: string) => void
}

export interface ProcessResult {
  runId: string
  extracted: number
  stored: number
  skipped: number
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.5
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_SUCCESS_THRESHOLD = 0.7

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export class LearningEventProcessor {
  private readonly eventBus: DzupEventBus
  private readonly memoryService: MemoryServiceLike
  private readonly tenantId: string
  private readonly confidenceThreshold: number
  private readonly ttlMs: number
  private readonly successScoreThreshold: number
  private readonly onError: (runId: string, message: string) => void

  private unsubscribe: (() => void) | null = null
  private running = false

  constructor(config: LearningEventProcessorConfig) {
    if (!config.eventBus) {
      throw new Error('LearningEventProcessor: eventBus is required')
    }
    if (!config.memoryService) {
      throw new Error('LearningEventProcessor: memoryService is required')
    }

    this.eventBus = config.eventBus
    this.memoryService = config.memoryService
    this.tenantId = config.tenantId && config.tenantId.length > 0 ? config.tenantId : 'default'
    this.confidenceThreshold = clamp01(
      typeof config.confidenceThreshold === 'number'
        ? config.confidenceThreshold
        : DEFAULT_CONFIDENCE_THRESHOLD,
    )
    this.ttlMs =
      typeof config.ttlMs === 'number' && config.ttlMs > 0 ? config.ttlMs : DEFAULT_TTL_MS
    this.successScoreThreshold = clamp01(
      typeof config.successScoreThreshold === 'number'
        ? config.successScoreThreshold
        : DEFAULT_SUCCESS_THRESHOLD,
    )
    this.onError = config.onError ?? defaultOnError
  }

  /** Whether the processor is currently subscribed to the event bus. */
  isRunning(): boolean {
    return this.running
  }

  /** Subscribe to `run:scored`. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.running) return
    this.unsubscribe = this.eventBus.on('run:scored', (event) => {
      void this.handle(event).catch((err) => {
        this.onError(event.runId, stringifyError(err))
      })
    })
    this.running = true
  }

  /** Remove the event subscription. Idempotent. */
  stop(): void {
    if (!this.running) return
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.running = false
  }

  /**
   * Core pattern extraction + persistence. Exposed for direct invocation by
   * tests and the `/ingest` HTTP handler.
   */
  async handle(event: DzupEventOf<'run:scored'>): Promise<ProcessResult> {
    const runId = event.runId
    const patterns = this.extractPatterns(event)
    const scope: Record<string, string> = { tenantId: this.tenantId }
    const provenance: { runId: string; score: number; agentId?: string } = {
      runId,
      score: event.score,
      ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
    }

    let stored = 0
    let skipped = 0

    for (const pattern of patterns) {
      if (pattern.confidence < this.confidenceThreshold) {
        skipped++
        continue
      }
      try {
        await storeLearningPattern(
          this.memoryService,
          scope,
          pattern,
          provenance,
          this.ttlMs,
        )
        stored++
      } catch (err) {
        this.onError(runId, `memory put failed: ${stringifyError(err)}`)
      }
    }

    return { runId, extracted: patterns.length, stored, skipped }
  }

  /**
   * Heuristic pattern extractor — inspects the `run:scored` payload and derives
   * generalizable `LearningPattern` entries:
   *  1. Each passing scorer contributes a "successful scoring heuristic" pattern
   *     with confidence = scorer score.
   *  2. Each failing scorer with a non-empty reasoning contributes a "failure
   *     mode" pattern with confidence = 1 - scorer score.
   *  3. Runs that complete with zero errors and above the success threshold
   *     contribute a "clean completion" pattern.
   *  4. Runs with repeated tool calls (toolCalls > 3) contribute a "heavy tool
   *     usage" pattern for the tool namespace.
   */
  private extractPatterns(event: DzupEventOf<'run:scored'>): LearningPattern[] {
    const patterns: LearningPattern[] = []

    for (const breakdown of event.scorerBreakdown) {
      if (breakdown.pass && breakdown.score > 0 && breakdown.reasoning.length > 0) {
        patterns.push({
          pattern: `Scorer "${breakdown.scorerName}" passed: ${breakdown.reasoning}`,
          context: `scorer:${breakdown.scorerName}`,
          confidence: clamp01(breakdown.score),
        })
      } else if (!breakdown.pass && breakdown.reasoning.length > 0) {
        patterns.push({
          pattern: `Scorer "${breakdown.scorerName}" failed: ${breakdown.reasoning}`,
          context: `failure:${breakdown.scorerName}`,
          confidence: clamp01(1 - breakdown.score),
        })
      }
    }

    if (event.passed && event.score >= this.successScoreThreshold) {
      if (event.metrics.errors === 0 && event.metrics.toolErrors === 0) {
        patterns.push({
          pattern: `Clean completion with ${event.metrics.toolCalls} tool call(s) and zero errors`,
          context: 'completion:clean',
          confidence: clamp01(event.score),
        })
      }
    }

    if (event.metrics.toolCalls > 3) {
      patterns.push({
        pattern: `Heavy tool usage: ${event.metrics.toolCalls} tool calls in a single run`,
        context: 'usage:heavy_tools',
        confidence: clamp01(event.score * 0.8),
      })
    }

    return patterns
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
  const prefix = runId ? `[LearningEventProcessor] run=${runId}` : '[LearningEventProcessor]'
  process.stderr.write(`${prefix} ${message}\n`)
}
