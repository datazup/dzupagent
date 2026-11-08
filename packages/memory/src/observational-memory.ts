/**
 * Observational Memory — Observer/Reflector pattern for continuous
 * conversation observation and consolidation.
 *
 * Two-stage pipeline inspired by Mastra's memory architecture:
 *
 * 1. **Observer:** Watches conversations, extracts structured observations
 *    when message count exceeds a threshold, deduplicates against existing
 *    memory, and stores new observations.
 *
 * 2. **Reflector:** When observations exceed a higher threshold, runs
 *    LLM-powered semantic consolidation to merge/prune redundant entries
 *    and garbage-collect low-confidence observations.
 *
 * All operations are non-fatal — failures are caught and do not break
 * the agent pipeline.
 *
 * @example
 * ```ts
 * const om = new ObservationalMemory({
 *   model: cheapModel,
 *   memoryService,
 *   namespace: 'observations',
 *   scope: { tenantId: 't1', observations: 'obs' },
 * })
 *
 * // After each conversation turn:
 * const result = await om.observe(messages)
 * // result is null if threshold not reached
 *
 * // Query relevant observations for prompt injection:
 * const context = await om.getRelevantObservations('user preferences', 5)
 * ```
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseStore } from '@langchain/langgraph'
import type { MemoryService } from './memory-service.js'
import type { Observation } from './observation-extractor.js'
import {
  ObservationExtractionError,
  ObservationExtractor,
} from './observation-extractor.js'
import { SemanticConsolidator } from './semantic-consolidation.js'
import { searchAllInNamespace } from './memory-service-store.js'
import type { StagedRecord, StagedWriter } from './staged-writer.js'
import { PolicyAwareStagedWriter } from './policy-aware-staged-writer.js'
import { defaultWritePolicy } from './write-policy.js'
import { ProvenanceWriter } from './provenance/provenance-writer.js'
import type {
  ObservationCandidateRetention,
  ObservationCandidateStore,
} from './observation-candidate-store.js'
import {
  createObservationConfirmationReceipt,
  observationCandidateValueDigest,
} from './observation-candidate-store.js'
import type {
  ObservationBufferLoadResult,
  ObservationBufferRecord,
  ObservationBufferStore,
} from './observation-buffer-store.js'
import {
  OBSERVATION_BUFFER_SCHEMA,
  deserializeObservationMessage,
  serializeObservationMessage,
} from './observation-buffer-store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObservationalMemoryConfig {
  /** LLM model for extraction and consolidation (use cheap tier) */
  model: BaseChatModel
  /** MemoryService for persistent storage */
  memoryService: MemoryService
  /** Underlying BaseStore for consolidation operations */
  store: BaseStore
  /** Namespace for observations */
  namespace: string
  /** Scope for memory operations */
  scope: Record<string, string>
  /** Message count threshold to trigger Observer (default: 15) */
  observerThreshold?: number | undefined
  /** Observation count threshold to trigger Reflector (default: 50) */
  reflectorThreshold?: number | undefined
  /** Max observations to keep after reflection (default: 30) */
  reflectorTargetCount?: number | undefined
  /** Minimum interval between Observer runs in ms (default: 30_000) */
  observerDebounceMs?: number | undefined
  /** Max LLM calls per Reflector run (default: 15) */
  reflectorMaxLLMCalls?: number | undefined
  /** Optional model-facing observation extraction prompt override. */
  observationPrompt?: string | undefined
  /** Version recorded on observations produced by `observationPrompt`. */
  observationPromptVersion?: string | undefined
  /** Stable host run identifier included in extracted evidence references. */
  observationRunId?: string | undefined
  /** Optional host resolver for stable source-message identifiers. */
  observationMessageReferenceResolver?:
    ((message: BaseMessage, index: number) => string | undefined) | undefined
  /** Maximum characters retained in each source excerpt (default: 240). */
  observationEvidenceExcerptMaxChars?: number | undefined
  /**
   * Persistence policy for model-written observations.
   *
   * - `direct` preserves the historical behavior and writes accepted
   *   observations immediately.
   * - `candidate-first` stages observations for explicit confirmation before
   *   they become durable long-term memory.
   *
   * Default: `direct` for backwards compatibility.
   */
  observationWriteMode?: 'direct' | 'candidate-first' | undefined
  /**
   * Optional staged writer used by `candidate-first` mode. When omitted, a
   * policy-aware writer is created that can auto-promote high-confidence
   * records to candidates but never auto-confirms model output.
   */
  stagedWriter?: StagedWriter | undefined
  /**
   * Optional restart-safe store for candidate-first records and confirmation
   * receipts. The store must be scoped separately from confirmed memory.
   */
  candidateStore?: ObservationCandidateStore | undefined
  /** Retention policy applied when a persistent candidate store is loaded. */
  candidateRetention?: ObservationCandidateRetention | undefined
  /**
   * Agent URI recorded as the creator of persisted observations.
   * Default: `forge://dzupagent/observer`.
   */
  observerAgentUri?: string | undefined
  /**
   * Narrow host adapter for candidate lifecycle telemetry and approval UX.
   * Handler failures are non-fatal and never alter memory state.
   */
  onObservationLifecycleEvent?:
    ((event: ObservationLifecycleEvent) => void) | undefined
  /**
   * Optional restart-safe store for the observer backlog: messages fed since
   * the last processed run, including a failed or unverified batch. The
   * record is kept until a run is processed (a verified durable candidate
   * handoff) and never exceeds the buffer cap. It holds raw conversation text.
   *
   * Requires `observationWriteMode: 'candidate-first'` and a `candidateStore`
   * implementing `loadWithStatus`. Without it, behaviour is unchanged.
   */
  pendingBuffer?: ObservationBufferStore | undefined
}

/**
 * Result of {@link ObservationalMemory.whenBufferPersisted}. `persisted` is
 * true when the durable backlog record matches the in-memory backlog.
 */
export interface BufferPersistResult {
  status: 'disabled' | 'persisted' | 'write-failed' | 'restore-pending'
  persisted: boolean
  /** Revision of the last record state the store accepted. */
  revision: number
}

export type ObservationLifecycleEventType =
  | 'observation:candidate:captured'
  | 'observation:candidate:promoted'
  | 'observation:candidate:confirmed'
  | 'observation:candidate:rejected'
  | 'observation:candidate:restored'
  | 'observation:candidate:pruned'
  | 'observation:candidate:persistence-failed'
  /**
   * An observer run failed (model extraction or store). `count` is the number
   * of messages kept for the retry; `reason` names the failure class only.
   */
  | 'observation:observer:failed'
  /** `pendingBuffer` only: a backlog write or delete failed (retried on the next change). */
  | 'observation:buffer:persistence-failed'
  /** `pendingBuffer` only: the backlog could not be read; restoration stays pending. */
  | 'observation:buffer:restore-failed'
  /** `pendingBuffer` only: candidate or durable-memory state could not be read. */
  | 'observation:state:read-failed'

export interface ObservationLifecycleEvent {
  schema: 'dzupagent/observation-lifecycle-event/v1'
  type: ObservationLifecycleEventType
  timestamp: number
  namespace: string
  scope: Record<string, string>
  candidateKey?: string | undefined
  stage?: StagedRecord['stage'] | undefined
  count?: number | undefined
  reason?: string | undefined
  evidenceRefs?: string[] | undefined
}

export interface ObservationalMemoryStats {
  totalObservations: number
  observerRuns: number
  reflectorRuns: number
  lastObserverRun: number | null
  lastReflectorRun: number | null
}

export interface ObserverResult {
  /** Accepted non-duplicate observations, whether persisted or staged. */
  extracted: Observation[]
  /** Observations persisted to durable memory during this observer run. */
  persisted: Observation[]
  /** Reviewable records awaiting promotion/confirmation. */
  staged: StagedRecord[]
  /** Observations rejected by the configured staged write policy. */
  rejected: Observation[]
  skippedDuplicates: number
  triggeredReflector: boolean
}

export interface ReflectorResult {
  before: number
  after: number
  merged: number
  pruned: number
  llmCallsUsed: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Token-level Jaccard similarity between two strings.
 * Used for cheap deduplication before storing observations.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/))
  const setB = new Set(b.toLowerCase().split(/\s+/))
  let intersection = 0
  for (const word of setA) {
    if (setB.has(word)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

function hasValidObservationEvidence(value: Record<string, unknown>): boolean {
  const references = value['evidenceReferences']
  return Array.isArray(references)
    && references.length > 0
    && references.every(reference => {
      if (!reference || typeof reference !== 'object') return false
      const item = reference as Record<string, unknown>
      return typeof item['ref'] === 'string'
        && item['ref'].startsWith('observation-message:')
        && typeof item['role'] === 'string'
        && typeof item['contentDigest'] === 'string'
        && /^[a-f0-9]{64}$/.test(item['contentDigest'])
        && typeof item['excerpt'] === 'string'
        && item['excerpt'].length > 0
    })
}

/** Jaccard threshold above which we consider two observations duplicates */
const DEDUP_THRESHOLD = 0.7

/**
 * `pendingBuffer` mode: state the observer needs could not be read, so
 * "empty" would be a guess. The run stages nothing and keeps its batch.
 */
class ObservationStateReadError extends Error {
  override readonly name = 'ObservationStateReadError'
  constructor(readonly readKind: 'candidate-restore' | 'dedup-read') {
    super(`observation state read failed (${readKind})`)
  }
}

// ---------------------------------------------------------------------------
// ObservationalMemory
// ---------------------------------------------------------------------------

export class ObservationalMemory {
  private stats: ObservationalMemoryStats = {
    totalObservations: 0,
    observerRuns: 0,
    reflectorRuns: 0,
    lastObserverRun: null,
    lastReflectorRun: null,
  }

  private messagesSinceLastRun = 0
  /** Messages fed since the last successful observer run (oldest first, bounded). */
  private pendingMessages: BaseMessage[] = []
  /** Bumped by reset() so an in-flight run cannot restore a cleared buffer. */
  private bufferEpoch = 0
  /** True while an observer run is in flight; concurrent triggers are no-ops. */
  private observerRunning = false
  /** When the last observer run failed; the debounce also applies after it. */
  private lastFailedObserverRun: number | null = null

  private readonly observerThreshold: number
  private readonly reflectorThreshold: number
  private readonly reflectorTargetCount: number
  private readonly observerDebounceMs: number
  private readonly reflectorMaxLLMCalls: number
  private readonly observationWriteMode: 'direct' | 'candidate-first'
  private readonly stagedWriter: StagedWriter | null
  private readonly provenanceWriter: ProvenanceWriter
  private readonly observerAgentUri: string
  private readonly candidateStore: ObservationCandidateStore | null
  private candidatesInitialized = false
  private candidateInitialization: Promise<void> | null = null
  private observationSequence = 0
  /**
   * Confirmed records removed from the writer by `flushConfirmed()` whose
   * durable write and receipt are not yet verified. Read only with
   * `pendingBuffer`, where dedup includes them.
   */
  private readonly inFlightFlushes = new Map<string, StagedRecord>()

  // ---------- pendingBuffer state (inert without config.pendingBuffer) -----
  private readonly pendingBuffer: ObservationBufferStore | null
  /** Serial queue of durable buffer operations, in call order. */
  private bufferQueue: Promise<void> = Promise.resolve()
  /** The batch detached by the running observer, or null. */
  private liveBatch: BaseMessage[] | null = null
  private bufferRestored = false
  private bufferRestoreInFlight: Promise<boolean> | null = null
  /** reset() ran while restoration was pending: the durable record is stale. */
  private bufferDiscardOnRestore = false
  /** A change happened while no write could be queued (restoration pending). */
  private bufferDirty = false
  /** Revision of the newest queued record state. */
  private bufferRevision = 0
  /** Revision of the newest record state the store accepted. */
  private bufferAppliedRevision = 0
  /** Last candidate-store failure in loadPersistedCandidates (pendingBuffer only). */
  private candidateLoadFailed = false
  /**
   * Staged candidates whose last putCandidateState returned false or threw,
   * with a copy of the record so the retry survives writer eviction. Cleared
   * only by a verified write or a verified durable flush.
   */
  private readonly candidateObligations = new Map<string, StagedRecord>()
  /** Candidate keys loaded from the candidate store (pendingBuffer only). */
  private readonly restoredCandidateKeys = new Set<string>()

  constructor(private readonly config: ObservationalMemoryConfig) {
    if (config.pendingBuffer) {
      if (
        (config.observationWriteMode ?? 'direct') !== 'candidate-first'
        || !config.candidateStore
      ) {
        throw new Error(
          'ObservationalMemory: pendingBuffer requires observationWriteMode "candidate-first" and a candidateStore',
        )
      }
      if (typeof config.candidateStore.loadWithStatus !== 'function') {
        throw new Error(
          'ObservationalMemory: pendingBuffer requires a candidateStore that implements loadWithStatus',
        )
      }
      if (config.pendingBuffer.namespace === config.namespace) {
        throw new Error(
          'ObservationalMemory: pendingBuffer must not use the observation namespace',
        )
      }
    }
    this.pendingBuffer = config.pendingBuffer ?? null
    this.observerThreshold = config.observerThreshold ?? 15
    this.reflectorThreshold = config.reflectorThreshold ?? 50
    this.reflectorTargetCount = config.reflectorTargetCount ?? 30
    this.observerDebounceMs = config.observerDebounceMs ?? 30_000
    this.reflectorMaxLLMCalls = config.reflectorMaxLLMCalls ?? 15
    this.observationWriteMode = config.observationWriteMode ?? 'direct'
    this.provenanceWriter = new ProvenanceWriter(config.memoryService)
    this.observerAgentUri = config.observerAgentUri ?? 'forge://dzupagent/observer'
    this.candidateStore = this.observationWriteMode === 'candidate-first'
      ? config.candidateStore ?? null
      : null
    this.stagedWriter = this.observationWriteMode === 'candidate-first'
      ? config.stagedWriter ?? new PolicyAwareStagedWriter({
          autoPromoteThreshold: 0.7,
          // Extractor confidence is clamped to 0..1. Keeping this threshold
          // above 1 guarantees that model self-confidence cannot bypass the
          // explicit confirmation gate.
          autoConfirmThreshold: 1.01,
          maxPending: 100,
          policies: [defaultWritePolicy],
        })
      : null
  }

  /**
   * Feed messages to the Observer. Call this after each conversation turn.
   *
   * If messageCount exceeds observerThreshold since last run:
   * 1. Extract observations using ObservationExtractor
   * 2. Dedup against existing observations (Jaccard similarity)
   * 3. Store new observations
   * 4. If total observations exceed reflectorThreshold, trigger Reflector
   *
   * Returns null if threshold not reached (no-op).
   */
  async observe(messages: BaseMessage[]): Promise<ObserverResult | null> {
    if (this.pendingBuffer) return this.observeWithPendingBuffer(messages)
    this.messagesSinceLastRun += messages.length
    this.bufferMessages(this.pendingMessages.concat(messages))

    if (this.messagesSinceLastRun < this.observerThreshold) {
      return null
    }

    if (
      this.stats.lastObserverRun !== null &&
      Date.now() - this.stats.lastObserverRun < this.observerDebounceMs
    ) {
      return null
    }
    // A failed run is debounced too, so an outage costs one attempt per
    // window rather than one per turn.
    if (
      this.lastFailedObserverRun !== null &&
      Date.now() - this.lastFailedObserverRun < this.observerDebounceMs
    ) {
      return null
    }

    // A run already in flight has not yet reset the threshold/debounce state,
    // so a second trigger would extract (and persist) the same window again.
    if (this.observerRunning) {
      return null
    }

    // Messages arriving while this run is in flight land in a fresh buffer
    // and wait for the next run.
    const batch = this.pendingMessages
    const batchCount = this.messagesSinceLastRun
    const epoch = this.bufferEpoch
    this.pendingMessages = []
    this.observerRunning = true
    try {
      const { result } = await this.runObserver(batch)
      if (epoch === this.bufferEpoch) {
        this.messagesSinceLastRun = Math.max(0, this.messagesSinceLastRun - batchCount)
      }
      return result
    } catch (error: unknown) {
      // Observer failure is non-fatal; keep the batch for the retry unless
      // reset() cleared the buffer meanwhile, and make the failure visible.
      if (epoch === this.bufferEpoch) {
        this.bufferMessages(batch.concat(this.pendingMessages))
        this.lastFailedObserverRun = Date.now()
      }
      const reason = error instanceof ObservationExtractionError
        ? `extraction-failed:${error.errorClass}`
        : `observer-failed:${error instanceof Error ? error.name : typeof error}`
      this.emitLifecycleCount('observation:observer:failed', batch.length, reason)
      return null
    } finally {
      this.observerRunning = false
    }
  }

  /**
   * `observe()` with a persisted backlog. Same trigger, debounce and
   * concurrency rules; additionally restores before first use, persists every
   * change through the serial buffer queue, and keeps the batch until the run
   * is processed (a verified durable candidate handoff).
   */
  private async observeWithPendingBuffer(
    messages: BaseMessage[],
  ): Promise<ObserverResult | null> {
    this.messagesSinceLastRun += messages.length
    this.bufferMessages(this.pendingMessages.concat(messages))
    if (messages.length > 0 || this.bufferAppliedRevision !== this.bufferRevision) {
      this.scheduleBufferWrite()
    }

    // The observer never runs while restoration is pending, so a batch can
    // never exclude unrestored messages.
    if (!await this.ensureBufferRestored()) return null

    if (this.messagesSinceLastRun < this.observerThreshold) {
      return null
    }
    if (
      this.stats.lastObserverRun !== null &&
      Date.now() - this.stats.lastObserverRun < this.observerDebounceMs
    ) {
      return null
    }
    if (
      this.lastFailedObserverRun !== null &&
      Date.now() - this.lastFailedObserverRun < this.observerDebounceMs
    ) {
      return null
    }
    if (this.observerRunning) {
      return null
    }

    const batch = this.pendingMessages
    const batchCount = this.messagesSinceLastRun
    const epoch = this.bufferEpoch
    this.pendingMessages = []
    // The durable record keeps the live batch plus arrivals until processed.
    this.liveBatch = batch
    this.observerRunning = true
    try {
      const { result, verified } = await this.runObserver(batch)
      if (epoch === this.bufferEpoch) {
        if (verified) {
          this.messagesSinceLastRun = Math.max(0, this.messagesSinceLastRun - batchCount)
        } else {
          // An unverified handoff is a failed run for the buffer.
          this.bufferMessages(batch.concat(this.pendingMessages))
          this.lastFailedObserverRun = Date.now()
        }
      }
      if (!verified) {
        this.emitLifecycleCount('observation:observer:failed', batch.length, 'handoff-unverified')
      }
      return result
    } catch (error: unknown) {
      if (epoch === this.bufferEpoch) {
        this.bufferMessages(batch.concat(this.pendingMessages))
        this.lastFailedObserverRun = Date.now()
      }
      const reason = error instanceof ObservationExtractionError
        ? `extraction-failed:${error.errorClass}`
        : error instanceof ObservationStateReadError
          ? `state-read-failed:${error.readKind}`
          : `observer-failed:${error instanceof Error ? error.name : typeof error}`
      this.emitLifecycleCount('observation:observer:failed', batch.length, reason)
      return null
    } finally {
      this.observerRunning = false
      this.liveBatch = null
      this.scheduleBufferWrite()
    }
  }

  /**
   * Restore the persisted backlog (`pendingBuffer` only). Shares one restore
   * with concurrent first `observe()` calls. Resolves `true` once restoration
   * is complete; `false` means the store could not be read and the next call
   * retries. Without `pendingBuffer` it resolves `true`.
   */
  async restorePendingMessages(): Promise<boolean> {
    return this.ensureBufferRestored()
  }

  /**
   * Resolve once every queued backlog operation has run, reporting whether
   * the durable record now matches the in-memory backlog.
   */
  async whenBufferPersisted(): Promise<BufferPersistResult> {
    if (!this.pendingBuffer) {
      return { status: 'disabled', persisted: false, revision: 0 }
    }
    let tail: Promise<void>
    do {
      tail = this.bufferQueue
      await tail
    } while (tail !== this.bufferQueue)
    if (!this.bufferRestored) {
      return {
        status: 'restore-pending',
        persisted: false,
        revision: this.bufferAppliedRevision,
      }
    }
    const persisted = !this.bufferDirty
      && this.bufferAppliedRevision === this.bufferRevision
    return {
      status: persisted ? 'persisted' : 'write-failed',
      persisted,
      revision: this.bufferAppliedRevision,
    }
  }

  /**
   * Run the Reflector: consolidate and garbage-collect observations.
   *
   * 1. Load all observations from the namespace
   * 2. Run SemanticConsolidator to merge/dedup
   * 3. If still over reflectorTargetCount, prune lowest-confidence entries
   * 4. Return consolidation stats
   */
  async reflect(): Promise<ReflectorResult> {
    return this.runReflector()
  }

  /** Manually trigger reflection regardless of thresholds */
  async forceReflect(): Promise<ReflectorResult> {
    return this.runReflector()
  }

  /** Get current stats */
  getStats(): ObservationalMemoryStats {
    return { ...this.stats }
  }

  /**
   * Return reviewable observations that have not yet been confirmed or
   * rejected. Empty in direct-write mode.
   */
  getPendingObservationCandidates(): StagedRecord[] {
    if (!this.stagedWriter) return []
    return [
      ...this.stagedWriter.getPending(),
      // A confirmed record remains reviewable when durable persistence could
      // not be verified and the record was restored for retry.
      ...this.stagedWriter.getByStage('confirmed'),
    ]
  }

  /**
   * Load restart-safe candidates before returning the review queue.
   * Prefer this method at process/session startup.
   */
  async listPendingObservationCandidates(): Promise<StagedRecord[]> {
    await this.initializeObservationCandidates()
    return this.getPendingObservationCandidates()
  }

  /**
   * Restore persisted candidate state and reconcile completed promotion
   * receipts. Safe to call repeatedly.
   */
  async initializeObservationCandidates(): Promise<void> {
    if (this.candidatesInitialized || !this.stagedWriter) return
    if (this.candidateInitialization) return this.candidateInitialization

    this.candidateInitialization = this.loadPersistedCandidates()
    try {
      await this.candidateInitialization
      // pendingBuffer mode: a failed candidate read stays retryable.
      if (!this.candidateLoadFailed) this.candidatesInitialized = true
    } finally {
      this.candidateInitialization = null
    }
  }

  /**
   * Explicitly confirm one staged observation and persist all records that
   * are now confirmed. Returns true when the requested key was persisted.
   */
  async confirmObservation(key: string): Promise<boolean> {
    await this.initializeObservationCandidates()
    const writer = this.stagedWriter
    if (!writer) return false

    let record = writer.get(key)
    const priorReceipt = await this.candidateStore?.getReceipt(
      this.config.namespace,
      this.config.scope,
      key,
    )
    if (
      priorReceipt
      && (
        !record
        || priorReceipt.valueDigest === observationCandidateValueDigest(record)
      )
    ) {
      return true
    }
    if (!record) return false

    if (record.stage === 'captured') {
      writer.promote(key)
      record = writer.get(key)
      if (record) this.emitLifecycle('observation:candidate:promoted', record)
    }
    if (record?.stage === 'candidate') {
      writer.confirm(key)
      const confirmedRecord = writer.get(key)
      if (confirmedRecord) {
        this.emitLifecycle('observation:candidate:confirmed', confirmedRecord)
      }
    }
    const confirmed = writer.get(key)
    if (confirmed?.stage !== 'confirmed') return false
    if (!hasValidObservationEvidence(confirmed.value)) {
      writer.reject(key)
      const rejected = writer.get(key)!
      this.emitLifecycle(
        'observation:candidate:rejected',
        rejected,
        'invalid or missing evidence references',
      )
      await this.putCandidateState(
        rejected,
        'candidate rejection could not be persisted',
      )
      return false
    }
    if (!await this.putCandidateState(
      confirmed,
      'confirmed candidate state could not be persisted',
    )) {
      return false
    }

    const persisted = await this.flushConfirmedObservations()
    return persisted.some(item => item.key === key)
  }

  /** Reject one staged observation so it cannot be promoted later. */
  async rejectObservation(key: string): Promise<boolean> {
    await this.initializeObservationCandidates()
    const writer = this.stagedWriter
    const prior = writer?.get(key)
    if (!writer || !prior) return false
    const rejected = writer.reject(key)
    if (!rejected) return false
    this.emitLifecycle('observation:candidate:rejected', rejected)
    if (!await this.putCandidateState(
      rejected,
      'candidate rejection could not be persisted',
    )) {
      writer.restore(prior)
      this.emitLifecycle(
        'observation:candidate:restored',
        prior,
        'rejection persistence failed',
      )
      return false
    }
    return true
  }

  /**
   * Persist and remove all confirmed observation records.
   *
   * This also supports custom staged writers that deliberately opt into
   * confidence-based auto-confirmation.
   */
  async flushConfirmedObservations(): Promise<StagedRecord[]> {
    await this.initializeObservationCandidates()
    const confirmed = this.stagedWriter?.flushConfirmed() ?? []
    // Removed from the writer but not yet durable: keep them visible to dedup.
    for (const record of confirmed) this.inFlightFlushes.set(record.key, record)
    const persisted: StagedRecord[] = []
    try {
      for (const record of confirmed) {
        const priorReceipt = await this.candidateStore?.getReceipt(
          record.namespace,
          record.scope,
          record.key,
        )
        if (
          priorReceipt
          && priorReceipt.valueDigest === observationCandidateValueDigest(record)
        ) {
          this.releaseInFlight(record)
          this.candidateObligations.delete(record.key)
          persisted.push(record)
          await this.candidateStore?.remove(record)
          continue
        }

        let stored = false
        try {
          stored = await this.persistObservation(
            record.key,
            record.value,
            record.confidence,
            true,
          )
        } catch {
          // Reported below through the same verified-persistence failure path.
        }
        if (stored) {
          if (this.candidateStore) {
            const receipt = createObservationConfirmationReceipt(record)
            if (!await this.putConfirmationReceipt(receipt)) {
              this.emitLifecycle(
                'observation:candidate:persistence-failed',
                record,
                'confirmation receipt could not be persisted',
              )
              await this.restoreConfirmedObservation(record)
              continue
            }
            // Write and receipt verified: durable from here on.
            this.releaseInFlight(record)
            this.candidateObligations.delete(record.key)
            await this.candidateStore.remove(record)
          }
          this.releaseInFlight(record)
          persisted.push(record)
        } else {
          this.emitLifecycle(
            'observation:candidate:persistence-failed',
            record,
            'confirmed observation write could not be verified',
          )
          await this.restoreConfirmedObservation(record)
        }
      }
    } catch (error: unknown) {
      // pendingBuffer mode: an exceptional exit (a receipt read or cleanup
      // rejection) must not hide records whose persistence is unverified.
      if (this.pendingBuffer) {
        for (const record of confirmed) {
          if (this.inFlightFlushes.get(record.key) !== record) continue
          this.stagedWriter?.restore(record)
          this.releaseInFlight(record)
          this.emitLifecycle(
            'observation:candidate:restored',
            record,
            'confirmed observation flush aborted; will be retried',
          )
        }
      }
      throw error
    } finally {
      for (const record of confirmed) this.releaseInFlight(record)
    }
    this.stats.totalObservations += persisted.length
    return persisted
  }

  /** Drop `record` from the in-flight set unless a newer flush owns the key. */
  private releaseInFlight(record: StagedRecord): void {
    if (this.inFlightFlushes.get(record.key) === record) {
      this.inFlightFlushes.delete(record.key)
    }
  }

  /** Get all stored observations */
  async getObservations(): Promise<Record<string, unknown>[]> {
    try {
      return await this.config.memoryService.get(
        this.config.namespace,
        this.config.scope,
      )
    } catch {
      return []
    }
  }

  /**
   * Format observations for prompt injection.
   * Returns the top-N most relevant observations for a query.
   */
  async getRelevantObservations(query: string, limit = 5): Promise<string> {
    try {
      const results = await this.config.memoryService.search(
        this.config.namespace,
        this.config.scope,
        query,
        limit,
      )

      if (results.length === 0) return ''

      return this.config.memoryService.formatForPrompt(results, {
        header: '## Relevant Observations',
        maxItems: limit,
      })
    } catch {
      return ''
    }
  }

  /** Reset counters (e.g., at session start) */
  reset(): void {
    this.messagesSinceLastRun = 0
    this.pendingMessages = []
    this.bufferEpoch++
    this.lastFailedObserverRun = null
    this.stats = {
      totalObservations: 0,
      observerRuns: 0,
      reflectorRuns: 0,
      lastObserverRun: null,
      lastReflectorRun: null,
    }
    if (this.pendingBuffer) {
      // The epoch bump above fences queued writes and an outstanding restore.
      this.liveBatch = null
      if (!this.bufferRestored) this.bufferDiscardOnRestore = true
      // Queues the delete, or holds it until a restore succeeds.
      this.scheduleBufferWrite()
    }
  }

  // ---------- Private --------------------------------------------------------

  /** Chain one durable buffer operation after every earlier one. */
  private enqueueBufferOp<T>(op: () => Promise<T>): Promise<T> {
    const run = this.bufferQueue.then(op)
    this.bufferQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * The backlog the durable record should hold now: the live batch followed
   * by the arrivals (or the pending messages), oldest dropped beyond the cap,
   * with the count lowered by the number dropped, as a put-back would.
   */
  private bufferSnapshot(): { messages: BaseMessage[]; count: number } {
    const backlog = this.liveBatch
      ? this.liveBatch.concat(this.pendingMessages)
      : this.pendingMessages
    const dropped = backlog.length - this.bufferCap()
    return dropped > 0
      ? {
          messages: backlog.slice(dropped),
          count: Math.max(0, this.messagesSinceLastRun - dropped),
        }
      : { messages: backlog, count: this.messagesSinceLastRun }
  }

  private bufferCap(): number {
    return Math.max(200, 4 * this.observerThreshold)
  }

  /**
   * Queue a write of the current backlog snapshot (a delete when it is
   * empty). While restoration is pending nothing reaches the durable record;
   * the change is remembered and written once a restore succeeds.
   */
  private scheduleBufferWrite(): void {
    const store = this.pendingBuffer
    if (!store) return
    if (!this.bufferRestored) {
      this.bufferDirty = true
      return
    }
    this.bufferDirty = false
    const epoch = this.bufferEpoch
    const revision = ++this.bufferRevision
    const snapshot = this.bufferSnapshot()
    let record: ObservationBufferRecord | null = null
    let serializationFailure: string | null = null
    if (snapshot.messages.length > 0) {
      try {
        record = {
          schema: OBSERVATION_BUFFER_SCHEMA,
          targetNamespace: this.config.namespace,
          scope: { ...this.config.scope },
          messages: snapshot.messages.map(serializeObservationMessage),
          messagesSinceLastRun: snapshot.count,
          revision,
          updatedAt: Date.now(),
        }
      } catch (error: unknown) {
        serializationFailure = error instanceof Error ? error.name : typeof error
      }
    }
    const size = snapshot.messages.length
    void this.enqueueBufferOp(async () => {
      // Dropped before it runs: reset() cleared this backlog.
      if (epoch !== this.bufferEpoch) return
      // A newer full snapshot is queued behind this one.
      if (revision < this.bufferRevision) return
      let ok = false
      let reason: string
      if (serializationFailure) {
        reason = `unserializable-message:${serializationFailure}`
      } else {
        try {
          ok = record
            ? await store.write(record)
            : await store.delete(this.config.namespace, this.config.scope)
        } catch {
          ok = false
        }
        reason = record ? 'buffer-write-failed' : 'buffer-delete-failed'
      }
      if (ok) {
        this.bufferAppliedRevision = Math.max(this.bufferAppliedRevision, revision)
      } else {
        this.emitLifecycleCount('observation:buffer:persistence-failed', size, reason)
      }
    })
  }

  /** One shared restore on the buffer queue; `true` once restoration is complete. */
  private ensureBufferRestored(): Promise<boolean> {
    const store = this.pendingBuffer
    if (!store || this.bufferRestored) return Promise.resolve(true)
    if (this.bufferRestoreInFlight) return this.bufferRestoreInFlight
    const epoch = this.bufferEpoch
    const restore = this.enqueueBufferOp(async (): Promise<boolean> => {
      let result: ObservationBufferLoadResult
      try {
        result = await store.load(this.config.namespace, this.config.scope)
      } catch (error: unknown) {
        result = {
          status: 'failed',
          errorClass: error instanceof Error ? error.name : typeof error,
        }
      }
      let restored: BaseMessage[] = []
      if (result.status === 'loaded') {
        try {
          restored = result.record.messages.map(deserializeObservationMessage)
        } catch {
          result = { status: 'failed', errorClass: 'invalid-record' }
        }
      }
      this.bufferRestoreInFlight = null
      if (result.status === 'failed') {
        this.emitLifecycleCount(
          'observation:buffer:restore-failed',
          this.pendingMessages.length,
          `buffer-restore-failed:${result.errorClass}`,
        )
        return false
      }

      this.bufferRestored = true
      if (result.status === 'loaded') {
        // The store now holds exactly this record.
        this.bufferRevision = Math.max(this.bufferRevision, result.record.revision)
        this.bufferAppliedRevision = this.bufferRevision
        if (epoch === this.bufferEpoch && !this.bufferDiscardOnRestore) {
          // Restored backlog and count go in front of messages observed since.
          this.messagesSinceLastRun += result.record.messagesSinceLastRun
          this.bufferMessages(restored.concat(this.pendingMessages))
          if (this.bufferSnapshot().messages.length !== restored.length) {
            this.bufferDirty = true
          }
        } else {
          // reset() fenced this result; the held delete is now released.
          this.bufferDirty = true
        }
      }
      this.bufferDiscardOnRestore = false
      if (this.bufferDirty) this.scheduleBufferWrite()
      return true
    })
    this.bufferRestoreInFlight = restore
    return restore
  }

  /** Texts of every non-terminal staged record plus in-flight flushes (sync). */
  private stagedDedupTexts(): string[] {
    const texts: string[] = []
    for (const record of this.stagedWriter?.getAll() ?? []) {
      if (record.stage === 'rejected') continue
      if (typeof record.value['text'] === 'string') texts.push(record.value['text'])
    }
    for (const record of this.inFlightFlushes.values()) {
      if (typeof record.value['text'] === 'string') texts.push(record.value['text'])
    }
    // Unresolved obligations stay non-terminal even after writer eviction.
    for (const record of this.candidateObligations.values()) {
      if (record.stage === 'rejected') continue
      if (typeof record.value['text'] === 'string') texts.push(record.value['text'])
    }
    return texts
  }

  /** pendingBuffer mode: never reuse a key that is staged, in flight, restored or durable. */
  private isObservationKeyOccupied(key: string, durableKeys: Set<string>): boolean {
    return this.stagedWriter?.get(key) !== undefined
      || this.inFlightFlushes.has(key)
      || this.candidateObligations.has(key)
      || this.restoredCandidateKeys.has(key)
      || durableKeys.has(key)
  }

  /**
   * Retry every unresolved candidate persistence obligation, with the live
   * record when it is still staged or in flight, else with the retained copy
   * (the writer may have evicted it). Resolves `true` when none remains.
   */
  private async retryCandidateObligations(): Promise<boolean> {
    for (const [key, retained] of [...this.candidateObligations]) {
      const record = this.stagedWriter?.get(key)
        ?? this.inFlightFlushes.get(key)
        ?? retained
      await this.putCandidateState(
        record,
        'candidate state retry could not be persisted',
      )
    }
    return this.candidateObligations.size === 0
  }

  /** Store `messages` as the pending buffer, dropping the oldest beyond the cap. */
  private bufferMessages(messages: BaseMessage[]): void {
    const cap = Math.max(200, 4 * this.observerThreshold)
    const dropped = messages.length - cap
    this.pendingMessages = dropped > 0 ? messages.slice(dropped) : messages
    if (dropped > 0) {
      // Dropped messages will never be extracted, so stop counting them.
      this.messagesSinceLastRun = Math.max(0, this.messagesSinceLastRun - dropped)
      this.emitLifecycleCount(
        'observation:candidate:pruned',
        dropped,
        `observer message buffer exceeded ${cap} messages; dropped oldest`,
      )
    }
  }

  /**
   * `verified` is always true without `pendingBuffer`. With it, it is true
   * only when every candidate this run staged was persisted and no candidate
   * persistence obligation remains after the retry.
   */
  private async runObserver(
    messages: BaseMessage[],
  ): Promise<{ result: ObserverResult; verified: boolean }> {
    await this.initializeObservationCandidates()
    const persistedBuffer = this.pendingBuffer !== null
    if (persistedBuffer && !this.candidatesInitialized) {
      // Unknown candidate state: staging now could duplicate a candidate.
      throw new ObservationStateReadError('candidate-restore')
    }
    const extractor = new ObservationExtractor({
      model: this.config.model,
      minMessages: 1,
      debounceMs: 0,
      ...(this.config.observationPrompt
        ? { prompt: this.config.observationPrompt }
        : {}),
      ...(this.config.observationPromptVersion
        ? { promptVersion: this.config.observationPromptVersion }
        : {}),
      ...(this.config.observationRunId
        ? { runId: this.config.observationRunId }
        : {}),
      ...(this.config.observationMessageReferenceResolver
        ? { messageReferenceResolver: this.config.observationMessageReferenceResolver }
        : {}),
      ...(this.config.observationEvidenceExcerptMaxChars !== undefined
        ? { evidenceExcerptMaxChars: this.config.observationEvidenceExcerptMaxChars }
        : {}),
    })

    // A model failure must not read as an empty run: throwing keeps the
    // batch (see observe()) instead of consuming it.
    const extraction = await extractor.extractWithOutcome(messages)
    if (extraction.status === 'failed') {
      throw new ObservationExtractionError(extraction.errorClass)
    }
    const observations = extraction.observations

    let existingTexts: string[]
    const durableKeys = new Set<string>()
    if (persistedBuffer) {
      // Snapshot staged and in-flight texts before awaiting the durable read,
      // so a record that becomes durable during the read is seen in one of
      // the two.
      const stagedTexts = this.stagedDedupTexts()
      let durable: Awaited<ReturnType<typeof searchAllInNamespace>>
      try {
        durable = await searchAllInNamespace(
          this.config.memoryService.getStore(),
          this.config.memoryService.getNamespaceTuple(
            this.config.namespace,
            this.config.scope,
          ),
        )
      } catch {
        this.emitLifecycleCount('observation:state:read-failed', messages.length, 'dedup-read')
        throw new ObservationStateReadError('dedup-read')
      }
      // Durable non-terminal candidates stay comparable after writer eviction.
      const candidateTexts: string[] = []
      let candidates: Awaited<ReturnType<NonNullable<ObservationCandidateStore['loadWithStatus']>>>
      try {
        candidates = await this.candidateStore!.loadWithStatus!(
          this.config.namespace,
          this.config.scope,
        )
      } catch (error: unknown) {
        candidates = {
          status: 'failed',
          errorClass: error instanceof Error ? error.name : typeof error,
        }
      }
      if (candidates.status === 'failed') {
        this.emitLifecycleCount('observation:state:read-failed', messages.length, 'candidate-dedup-read')
        throw new ObservationStateReadError('candidate-restore')
      }
      if (candidates.status === 'loaded') {
        for (const record of candidates.records) {
          durableKeys.add(record.key)
          if (record.stage === 'rejected') continue
          if (typeof record.value['text'] === 'string') candidateTexts.push(record.value['text'])
        }
      }
      stagedTexts.push(...candidateTexts)
      // A staged record that is neither a durable candidate nor a durable
      // observation cannot discharge a batch by matching as a duplicate:
      // track it as an unresolved obligation so the run must persist it.
      const durableCandidateKeys = new Set(
        candidates.status === 'loaded' ? candidates.records.map(record => record.key) : [],
      )
      const durableObservationKeys = new Set(durable.map(item => item.key))
      for (const record of this.stagedWriter?.getAll() ?? []) {
        if (record.stage === 'rejected') continue
        if (durableCandidateKeys.has(record.key) || durableObservationKeys.has(record.key)) continue
        if (this.inFlightFlushes.has(record.key) || this.candidateObligations.has(record.key)) continue
        this.candidateObligations.set(record.key, record)
      }
      for (const item of durable) durableKeys.add(item.key)
      existingTexts = durable
        .map(item => {
          const text = (item.value as Record<string, unknown>)['text']
          return typeof text === 'string' ? text : ''
        })
        .filter(Boolean)
        .concat(stagedTexts)
    } else {
      // Load existing observations for dedup
      const existing = await this.config.memoryService.get(
        this.config.namespace,
        this.config.scope,
      )

      existingTexts = existing
        .map(r => (typeof r['text'] === 'string' ? r['text'] : ''))
        .filter(Boolean)
      for (const record of this.stagedWriter?.getPending() ?? []) {
        if (typeof record.value['text'] === 'string') {
          existingTexts.push(record.value['text'])
        }
      }
    }
    let stagedPersistFailures = 0

    const added: Observation[] = []
    const persisted: Observation[] = []
    const staged: StagedRecord[] = []
    const rejected: Observation[] = []
    const observationByKey = new Map<string, Observation>()
    let skipped = 0

    for (const obs of observations) {
      // Check Jaccard similarity against existing observations
      const isDuplicate = existingTexts.some(
        existingText => jaccardSimilarity(obs.text, existingText) > DEDUP_THRESHOLD,
      )

      if (isDuplicate) {
        skipped++
        continue
      }

      // Also check against observations added in this batch
      const isBatchDuplicate = added.some(
        a => jaccardSimilarity(obs.text, a.text) > DEDUP_THRESHOLD,
      )

      if (isBatchDuplicate) {
        skipped++
        continue
      }

      let key = `obs-${Date.now()}-${this.observationSequence++}`
      // pendingBuffer mode: a restart in the same millisecond restarts the
      // sequence at 0, so skip keys that are already occupied.
      while (persistedBuffer && this.isObservationKeyOccupied(key, durableKeys)) {
        key = `obs-${Date.now()}-${this.observationSequence++}`
      }
      const value = {
        text: obs.text,
        category: obs.category,
        confidence: obs.confidence,
        source: 'observer' as const,
        createdAt: obs.createdAt,
        modelGenerated: true,
        promptVersion: obs.promptVersion,
        sourceMessageCount: obs.sourceMessageCount,
        evidenceReferences: obs.evidenceReferences,
      }

      if (this.observationWriteMode === 'candidate-first') {
        const candidate = this.stagedWriter!.capture({
          key,
          namespace: this.config.namespace,
          scope: this.config.scope,
          value,
          confidence: obs.confidence,
          captureReason: 'model-extracted observation awaiting long-term-memory confirmation',
        })
        this.emitLifecycle(
          'observation:candidate:captured',
          { ...candidate, stage: 'captured' },
        )
        if (candidate.stage === 'rejected') {
          this.emitLifecycle('observation:candidate:rejected', candidate)
          rejected.push(obs)
          continue
        }
        if (candidate.stage === 'candidate' || candidate.stage === 'confirmed') {
          this.emitLifecycle('observation:candidate:promoted', candidate)
        }
        if (candidate.stage === 'confirmed') {
          this.emitLifecycle('observation:candidate:confirmed', candidate)
        }
        if (!await this.putCandidateState(
          candidate,
          'captured candidate state could not be persisted',
        )) {
          stagedPersistFailures++
        }
        observationByKey.set(key, obs)
        if (candidate.stage !== 'confirmed') {
          staged.push(candidate)
        }
      } else {
        await this.persistObservation(key, value, obs.confidence)
        persisted.push(obs)
      }
      added.push(obs)
    }

    if (this.observationWriteMode === 'candidate-first') {
      const autoConfirmed = await this.flushConfirmedObservations()
      for (const record of autoConfirmed) {
        const observation = observationByKey.get(record.key)
        if (observation) persisted.push(observation)
      }
    } else {
      this.stats.totalObservations += persisted.length
    }

    let verified = true
    if (persistedBuffer) {
      // Includes candidates this extraction matched as duplicates: a
      // duplicate discharges the batch only when its match is durable.
      const obligationsResolved = await this.retryCandidateObligations()
      verified = stagedPersistFailures === 0 && obligationsResolved
    }

    this.stats.lastObserverRun = Date.now()
    this.stats.observerRuns++

    // Check if reflector should run
    let triggeredReflector = false
    if (this.stats.totalObservations > this.reflectorThreshold) {
      try {
        await this.runReflector()
        triggeredReflector = true
      } catch {
        // Reflector failure is non-fatal
      }
    }

    return {
      result: {
        extracted: added,
        persisted,
        staged,
        rejected,
        skippedDuplicates: skipped,
        triggeredReflector,
      },
      verified,
    }
  }

  private async persistObservation(
    key: string,
    value: Record<string, unknown>,
    confidence: number,
    verify = false,
  ): Promise<boolean> {
    await this.provenanceWriter.put(
      this.config.namespace,
      this.config.scope,
      key,
      value,
      {
        agentUri: this.observerAgentUri,
        source: 'derived',
        confidence,
      },
    )

    if (!verify) return true

    try {
      const stored = await this.config.memoryService.get(
        this.config.namespace,
        this.config.scope,
        key,
      )
      return stored.length > 0
    } catch {
      return false
    }
  }

  private async restoreConfirmedObservation(record: StagedRecord): Promise<void> {
    const writer = this.stagedWriter
    if (!writer) return

    writer.restore(record)
    // Back in the writer, so dedup sees it there.
    this.releaseInFlight(record)
    this.emitLifecycle(
      'observation:candidate:restored',
      record,
      'confirmed observation persistence will be retried',
    )
    await this.putCandidateState(
      record,
      'restored candidate state could not be persisted',
    )
  }

  private async loadPersistedCandidates(): Promise<void> {
    if (this.pendingBuffer) return this.loadPersistedCandidatesWithStatus()
    const writer = this.stagedWriter
    const store = this.candidateStore
    if (!writer || !store) return

    const pruned = await store.prune(
      this.config.namespace,
      this.config.scope,
      this.config.candidateRetention,
    )
    if (pruned > 0) {
      this.emitLifecycleCount(
        'observation:candidate:pruned',
        pruned,
        'candidate retention policy',
      )
    }
    const records = await store.load(this.config.namespace, this.config.scope)
    for (const record of records) {
      const receipt = await store.getReceipt(
        record.namespace,
        record.scope,
        record.key,
      )
      if (
        receipt
        && receipt.valueDigest === observationCandidateValueDigest(record)
      ) {
        await store.remove(record)
        continue
      }
      writer.restore(record)
      this.emitLifecycle(
        'observation:candidate:restored',
        record,
        'restored from persistent candidate storage',
      )
    }
  }

  /**
   * `pendingBuffer` mode: restore candidates through the error-preserving
   * `loadWithStatus`. A failure leaves initialization incomplete (retryable)
   * instead of reading as "no candidates".
   */
  private async loadPersistedCandidatesWithStatus(): Promise<void> {
    const writer = this.stagedWriter
    const store = this.candidateStore
    this.candidateLoadFailed = false
    if (!writer || !store?.loadWithStatus) return

    try {
      const pruned = await store.prune(
        this.config.namespace,
        this.config.scope,
        this.config.candidateRetention,
      )
      if (pruned > 0) {
        this.emitLifecycleCount(
          'observation:candidate:pruned',
          pruned,
          'candidate retention policy',
        )
      }
      const loaded = await store.loadWithStatus(this.config.namespace, this.config.scope)
      if (loaded.status === 'failed') {
        this.candidateLoadFailed = true
        this.emitLifecycleCount(
          'observation:state:read-failed',
          0,
          `candidate-restore:${loaded.errorClass}`,
        )
        return
      }
      const records = loaded.status === 'loaded' ? loaded.records : []
      for (const record of records) this.restoredCandidateKeys.add(record.key)
      for (const record of records) {
        const receipt = await store.getReceipt(
          record.namespace,
          record.scope,
          record.key,
        )
        if (
          receipt
          && receipt.valueDigest === observationCandidateValueDigest(record)
        ) {
          await store.remove(record)
          continue
        }
        writer.restore(record)
        this.emitLifecycle(
          'observation:candidate:restored',
          record,
          'restored from persistent candidate storage',
        )
      }
    } catch (error: unknown) {
      this.candidateLoadFailed = true
      this.emitLifecycleCount(
        'observation:state:read-failed',
        0,
        `candidate-restore:${error instanceof Error ? error.name : typeof error}`,
      )
    }
  }

  private emitLifecycle(
    type: ObservationLifecycleEventType,
    record: StagedRecord,
    reason?: string,
  ): void {
    const references = record.value['evidenceReferences']
    const evidenceRefs = Array.isArray(references)
      ? references
          .map(reference => (
            reference && typeof reference === 'object'
              ? (reference as Record<string, unknown>)['ref']
              : undefined
          ))
          .filter((ref): ref is string => typeof ref === 'string')
      : []
    this.emitLifecycleEvent({
      schema: 'dzupagent/observation-lifecycle-event/v1',
      type,
      timestamp: Date.now(),
      namespace: record.namespace,
      scope: { ...record.scope },
      candidateKey: record.key,
      stage: record.stage,
      ...(reason ? { reason } : {}),
      ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    })
  }

  private emitLifecycleCount(
    type: ObservationLifecycleEventType,
    count: number,
    reason?: string,
  ): void {
    this.emitLifecycleEvent({
      schema: 'dzupagent/observation-lifecycle-event/v1',
      type,
      timestamp: Date.now(),
      namespace: this.config.namespace,
      scope: { ...this.config.scope },
      count,
      ...(reason ? { reason } : {}),
    })
  }

  private emitLifecycleEvent(event: ObservationLifecycleEvent): void {
    try {
      this.config.onObservationLifecycleEvent?.(event)
    } catch {
      // Lifecycle telemetry is deliberately non-fatal.
    }
  }

  private async putCandidateState(
    record: StagedRecord,
    failureReason: string,
  ): Promise<boolean> {
    if (!this.candidateStore) return true
    try {
      if (await this.candidateStore.put(record)) {
        this.candidateObligations.delete(record.key)
        return true
      }
    } catch {
      // Converted to a lifecycle failure below.
    }
    // pendingBuffer mode: an unresolved obligation blocks processing.
    if (this.pendingBuffer) {
      this.candidateObligations.set(record.key, {
        ...record,
        scope: { ...record.scope },
        value: { ...record.value },
      })
    }
    this.emitLifecycle(
      'observation:candidate:persistence-failed',
      record,
      failureReason,
    )
    return false
  }

  private async putConfirmationReceipt(
    receipt: ReturnType<typeof createObservationConfirmationReceipt>,
  ): Promise<boolean> {
    if (!this.candidateStore) return true
    try {
      return await this.candidateStore.putReceipt(receipt)
    } catch {
      return false
    }
  }

  private async runReflector(): Promise<ReflectorResult> {
    const { store, namespace, scope, memoryService, model } = this.config

    // 1. Load all observations to count before
    const allBefore = await memoryService.get(namespace, scope)
    const before = allBefore.length

    if (before === 0) {
      return { before: 0, after: 0, merged: 0, pruned: 0, llmCallsUsed: 0 }
    }

    // 2. Run semantic consolidation directly on the store
    const consolidator = new SemanticConsolidator({
      model,
      topK: 5,
      maxLLMCalls: this.reflectorMaxLLMCalls,
    })

    // The store tuple MemoryService writes this namespace under:
    // [namespace, ...scope values in scopeKeys order] (DZUPAGENT-AGENT-H-66 —
    // `Object.values(scope)` omitted the namespace name, so consolidation and
    // pruning never touched the real records).
    let namespaceTuple: string[] | undefined
    try {
      namespaceTuple = memoryService.getNamespaceTuple(namespace, scope)
    } catch {
      namespaceTuple = undefined
    }

    let llmCallsUsed = 0
    let merged = 0

    if (namespaceTuple) {
      try {
        const result = await consolidator.consolidate(store, namespaceTuple)
        llmCallsUsed = result.llmCallsUsed
        merged = result.actions.filter(
          a => a.decision.action === 'merge' ||
               a.decision.action === 'update' ||
               a.decision.action === 'noop' ||
               a.decision.action === 'delete',
        ).length
      } catch {
        // Consolidation failure is non-fatal — continue to pruning
      }
    }

    // 3. If still over target, prune lowest-confidence entries
    let pruned = 0
    try {
      const remaining = await memoryService.get(namespace, scope)

      if (namespaceTuple && remaining.length > this.reflectorTargetCount) {
        // Sort by confidence ascending (lowest first)
        const withConfidence = remaining.map(r => ({
          value: r,
          confidence: typeof r['confidence'] === 'number' ? r['confidence'] : 0.5,
          text: typeof r['text'] === 'string' ? r['text'] : '',
        }))
        withConfidence.sort((a, b) => a.confidence - b.confidence)

        const toRemove = remaining.length - this.reflectorTargetCount

        // Use store.search to find and delete entries by their text content.
        // This is necessary because MemoryService.get doesn't return keys.
        const rawItems = await searchAllInNamespace(store, namespaceTuple)
        const keyMap = new Map<string, string>()
        for (const item of rawItems) {
          const text = typeof (item.value as Record<string, unknown>)['text'] === 'string'
            ? (item.value as Record<string, unknown>)['text'] as string
            : ''
          if (text) {
            keyMap.set(text, item.key)
          }
        }

        for (let i = 0; i < toRemove && i < withConfidence.length; i++) {
          const entry = withConfidence[i]
          if (!entry) continue
          const key = keyMap.get(entry.text)
          if (key) {
            try {
              await store.delete(namespaceTuple, key)
              pruned++
            } catch {
              // Non-fatal — deletion of a single record failed
            }
          }
        }
      }
    } catch {
      // Pruning failure is non-fatal
    }

    const allAfter = await memoryService.get(namespace, scope)
    const after = allAfter.length

    this.stats.reflectorRuns++
    this.stats.lastReflectorRun = Date.now()
    this.stats.totalObservations = after

    return { before, after, merged, pruned, llmCallsUsed }
  }
}
