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
import { ObservationExtractor } from './observation-extractor.js'
import { SemanticConsolidator } from './semantic-consolidation.js'
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

/** Jaccard threshold above which we consider two observations duplicates */
const DEDUP_THRESHOLD = 0.7

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

  constructor(private readonly config: ObservationalMemoryConfig) {
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
    this.messagesSinceLastRun += messages.length

    if (this.messagesSinceLastRun < this.observerThreshold) {
      return null
    }

    if (
      this.stats.lastObserverRun !== null &&
      Date.now() - this.stats.lastObserverRun < this.observerDebounceMs
    ) {
      return null
    }

    try {
      return await this.runObserver(messages)
    } catch {
      // Observer failure is non-fatal
      return null
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
      this.candidatesInitialized = true
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
    }
    if (record?.stage === 'candidate') {
      writer.confirm(key)
    }
    const confirmed = writer.get(key)
    if (confirmed?.stage !== 'confirmed') return false
    if (this.candidateStore && !await this.candidateStore.put(confirmed)) {
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
    if (this.candidateStore && !await this.candidateStore.put(rejected)) {
      writer.restore(prior)
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
    const persisted: StagedRecord[] = []
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
        persisted.push(record)
        await this.candidateStore?.remove(record)
        continue
      }

      const stored = await this.persistObservation(
        record.key,
        record.value,
        record.confidence,
        true,
      )
      if (stored) {
        if (this.candidateStore) {
          const receipt = createObservationConfirmationReceipt(record)
          if (!await this.candidateStore.putReceipt(receipt)) {
            await this.restoreConfirmedObservation(record)
            continue
          }
          await this.candidateStore.remove(record)
        }
        persisted.push(record)
      } else {
        await this.restoreConfirmedObservation(record)
      }
    }
    this.stats.totalObservations += persisted.length
    return persisted
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
    this.stats = {
      totalObservations: 0,
      observerRuns: 0,
      reflectorRuns: 0,
      lastObserverRun: null,
      lastReflectorRun: null,
    }
  }

  // ---------- Private --------------------------------------------------------

  private async runObserver(messages: BaseMessage[]): Promise<ObserverResult> {
    await this.initializeObservationCandidates()
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
    })

    const observations = await extractor.extract(messages)

    // Load existing observations for dedup
    const existing = await this.config.memoryService.get(
      this.config.namespace,
      this.config.scope,
    )

    const existingTexts = existing
      .map(r => (typeof r['text'] === 'string' ? r['text'] : ''))
      .filter(Boolean)
    for (const record of this.stagedWriter?.getPending() ?? []) {
      if (typeof record.value['text'] === 'string') {
        existingTexts.push(record.value['text'])
      }
    }

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

      const key = `obs-${Date.now()}-${this.observationSequence++}`
      const value = {
        text: obs.text,
        category: obs.category,
        confidence: obs.confidence,
        source: 'observer' as const,
        createdAt: obs.createdAt,
        modelGenerated: true,
        promptVersion: obs.promptVersion,
        sourceMessageCount: obs.sourceMessageCount,
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
        if (candidate.stage === 'rejected') {
          rejected.push(obs)
          continue
        }
        await this.candidateStore?.put(candidate)
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

    this.messagesSinceLastRun = 0
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
      extracted: added,
      persisted,
      staged,
      rejected,
      skippedDuplicates: skipped,
      triggeredReflector,
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
    await this.candidateStore?.put(record)
  }

  private async loadPersistedCandidates(): Promise<void> {
    const writer = this.stagedWriter
    const store = this.candidateStore
    if (!writer || !store) return

    await store.prune(
      this.config.namespace,
      this.config.scope,
      this.config.candidateRetention,
    )
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

    // Build the namespace tuple from NamespaceConfig via a search call
    // to determine the store tuple. We search for one record and derive
    // the namespace from it. Instead, we can build it from scope keys
    // by matching the MemoryService convention (scope values as tuple).
    const namespaceTuple = Object.values(scope)

    let llmCallsUsed = 0
    let merged = 0

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

    // 3. If still over target, prune lowest-confidence entries
    let pruned = 0
    try {
      const remaining = await memoryService.get(namespace, scope)

      if (remaining.length > this.reflectorTargetCount) {
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
        const rawItems = await store.search(namespaceTuple, { limit: 500 })
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
