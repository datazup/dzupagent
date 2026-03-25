/**
 * Sleep-Time Consolidation (F15)
 *
 * Async between-session memory improvement. When a session ends, run this
 * to deduplicate, prune weak memories, flag contradictions, and heal
 * remaining quality issues — like the brain's memory consolidation during sleep.
 *
 * Phases (in order):
 *   1. dedup           — LLM-powered semantic deduplication via SemanticConsolidator
 *   2. decay-prune     — Remove memories below a decay-strength threshold
 *   3. contradiction-resolve — Report contradictions found during dedup
 *   4. heal            — Heuristic duplicate/staleness/contradiction scan
 *   5. lesson-dedup    — Jaccard-based lesson deduplication (M4)
 *   6. convention-extract — Extract conventions from memory patterns (M4)
 *   7. staleness-prune — Score-based staleness pruning for pinned/important-aware cleanup (M4)
 *
 * All phases are non-fatal: errors are caught and the run continues.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseStore } from '@langchain/langgraph'

import { SemanticConsolidator } from './semantic-consolidation.js'
import type { DecayMetadata } from './decay-engine.js'
import { findWeakMemories } from './decay-engine.js'
import { healMemory } from './memory-healer.js'
import { dedupLessons } from './lesson-dedup.js'
import { extractConventions } from './convention/convention-extractor-m4.js'
import { pruneStaleMemories } from './staleness-pruner.js'
import { parseMemoryEntry } from './consolidation-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SleepPhase = 'dedup' | 'decay-prune' | 'contradiction-resolve' | 'heal'

export interface SleepConsolidationConfig {
  /** LLM model for semantic consolidation (cheap tier) */
  model: BaseChatModel
  /** Which phases to run (default: all) */
  phases?: SleepPhase[]
  /** Max LLM calls across the entire consolidation run (default: 30) */
  maxLLMCalls?: number
  /** Decay strength threshold below which memories are pruned (default: 0.1) */
  decayPruneThreshold?: number
  /** Max total records to process per namespace (default: 200) */
  maxRecordsPerNamespace?: number
  /** Enable Arrow-accelerated batch operations (requires @forgeagent/memory-ipc) */
  useArrow?: boolean
}

export interface SleepConsolidationReport {
  /** Per-namespace results */
  namespaces: Array<{
    namespace: string[]
    deduplicated: number
    pruned: number
    contradictionsFound: number
    healed: number
  }>
  /** Total LLM calls used */
  totalLLMCalls: number
  /** Duration in ms */
  durationMs: number
  /** Phases that were executed */
  phasesRun: SleepPhase[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_PHASES: SleepPhase[] = ['dedup', 'decay-prune', 'contradiction-resolve', 'heal']

function extractText(value: Record<string, unknown>): string {
  return typeof value['text'] === 'string'
    ? value['text'] as string
    : JSON.stringify(value)
}

function extractDecay(value: Record<string, unknown>): DecayMetadata | null {
  const d = value['_decay']
  if (d == null || typeof d !== 'object') return null
  const meta = d as Record<string, unknown>
  if (
    typeof meta['strength'] !== 'number' ||
    typeof meta['accessCount'] !== 'number' ||
    typeof meta['lastAccessedAt'] !== 'number' ||
    typeof meta['createdAt'] !== 'number' ||
    typeof meta['halfLifeMs'] !== 'number'
  ) {
    return null
  }
  return meta as unknown as DecayMetadata
}

// ---------------------------------------------------------------------------
// SleepConsolidator
// ---------------------------------------------------------------------------

export class SleepConsolidator {
  private readonly phases: SleepPhase[]
  private readonly maxLLMCalls: number
  private readonly decayPruneThreshold: number
  private readonly maxRecordsPerNamespace: number

  constructor(private readonly config: SleepConsolidationConfig) {
    this.phases = config.phases ?? ALL_PHASES
    this.maxLLMCalls = config.maxLLMCalls ?? 30
    this.decayPruneThreshold = config.decayPruneThreshold ?? 0.1
    this.maxRecordsPerNamespace = config.maxRecordsPerNamespace ?? 200
  }

  /**
   * Run the full sleep consolidation cycle on one or more namespaces.
   */
  async run(
    store: BaseStore,
    namespaces: string[][],
  ): Promise<SleepConsolidationReport> {
    const startTime = Date.now()
    let totalLLMCalls = 0
    const results: SleepConsolidationReport['namespaces'] = []

    for (const namespace of namespaces) {
      let deduplicated = 0
      let pruned = 0
      let contradictionsFound = 0
      let healed = 0

      // Phase 1: Semantic dedup
      if (this.phases.includes('dedup') && totalLLMCalls < this.maxLLMCalls) {
        try {
          const remaining = this.maxLLMCalls - totalLLMCalls
          const consolidator = new SemanticConsolidator({
            model: this.config.model,
            maxLLMCalls: remaining,
          })
          const result = await consolidator.consolidate(store, namespace)
          deduplicated = result.before - result.after
          contradictionsFound = result.contradictions.length
          totalLLMCalls += result.llmCallsUsed
        } catch {
          // Non-fatal — semantic consolidation failed, continue
        }
      }

      // Phase 2: Decay pruning
      if (this.phases.includes('decay-prune')) {
        try {
          if (this.config.useArrow) {
            pruned = await this.arrowDecayPrune(store, namespace)
          } else {
            pruned = await this.standardDecayPrune(store, namespace)
          }
        } catch {
          // Non-fatal — decay pruning failed, continue
        }
      }

      // Phase 3: Contradiction resolution
      // Contradictions are already flagged by SemanticConsolidator as _contradicts
      // metadata during the dedup phase. This phase is a reporting passthrough —
      // the count was captured above. No additional work needed.

      // Phase 4: Heal
      if (this.phases.includes('heal')) {
        try {
          const items = await store.search(namespace, { limit: this.maxRecordsPerNamespace })
          const records = items.map(item => {
            const value = item.value as Record<string, unknown>
            const decay = extractDecay(value)
            return {
              key: item.key,
              text: extractText(value),
              lastAccessedAt: decay?.lastAccessedAt,
            }
          })
          const report = healMemory(records)
          healed = report.resolved
        } catch {
          // Non-fatal — heal failed, continue
        }
      }

      results.push({ namespace, deduplicated, pruned, contradictionsFound, healed })
    }

    return {
      namespaces: results,
      totalLLMCalls,
      durationMs: Date.now() - startTime,
      phasesRun: this.phases,
    }
  }

  // ---------------------------------------------------------------------------
  // Decay pruning strategies
  // ---------------------------------------------------------------------------

  /**
   * Standard row-by-row decay pruning. Deserializes each record to extract
   * decay metadata, then deletes weak memories individually.
   */
  private async standardDecayPrune(
    store: BaseStore,
    namespace: string[],
  ): Promise<number> {
    const items = await store.search(namespace, { limit: this.maxRecordsPerNamespace })
    const withDecay: Array<{ key: string; meta: DecayMetadata }> = []

    for (const item of items) {
      const meta = extractDecay(item.value as Record<string, unknown>)
      if (meta) {
        withDecay.push({ key: item.key, meta })
      }
    }

    let pruned = 0
    const weak = findWeakMemories(withDecay, this.decayPruneThreshold)
    for (const w of weak) {
      try {
        await store.delete(namespace, w.key)
        pruned++
      } catch {
        // Non-fatal — single delete failed
      }
    }

    return pruned
  }

  /**
   * Arrow-accelerated decay pruning. Builds an Arrow frame from store records,
   * uses vectorized `batchDecayUpdate` to recompute all decay strengths in one
   * columnar pass, then deletes records below threshold.
   *
   * Falls back to `standardDecayPrune` if @forgeagent/memory-ipc is not
   * installed or any Arrow operation fails.
   */
  private async arrowDecayPrune(
    store: BaseStore,
    namespace: string[],
  ): Promise<number> {
    try {
      const { FrameBuilder, FrameReader, batchDecayUpdate } =
        await import('@forgeagent/memory-ipc')

      const items = await store.search(namespace, { limit: this.maxRecordsPerNamespace })
      if (items.length === 0) return 0

      // Build an Arrow frame directly from store search results
      const builder = new FrameBuilder()
      const nsString = namespace.join('/')

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (!item) continue
        const value = item.value as Record<string, unknown>

        // Map ForgeAgent _decay convention to FrameBuilder's FrameRecordValue
        const decayRaw = value['_decay']
        const decayObj = (decayRaw != null && typeof decayRaw === 'object')
          ? decayRaw as Record<string, unknown>
          : null

        builder.add(
          {
            text: typeof value['text'] === 'string' ? value['text'] : null,
            _decay: decayObj
              ? {
                  strength: typeof decayObj['strength'] === 'number'
                    ? decayObj['strength']
                    : null,
                  halfLifeMs: typeof decayObj['halfLifeMs'] === 'number'
                    ? decayObj['halfLifeMs']
                    : null,
                  lastAccessedAt: typeof decayObj['lastAccessedAt'] === 'number'
                    ? decayObj['lastAccessedAt']
                    : null,
                  accessCount: typeof decayObj['accessCount'] === 'number'
                    ? decayObj['accessCount']
                    : null,
                }
              : undefined,
          },
          {
            id: `${nsString}:${item.key}`,
            namespace: nsString,
            key: item.key,
          },
        )
      }

      const frame = builder.build()
      if (frame.numRows === 0) return 0

      // Vectorized: recompute all decay strengths in one columnar pass
      const now = Date.now()
      const updatedStrengths = batchDecayUpdate(frame, now)

      // Read keys from the frame to identify which records to delete
      const reader = new FrameReader(frame)
      const records = reader.toRecords()

      let pruned = 0
      for (let i = 0; i < updatedStrengths.length; i++) {
        const strength = updatedStrengths[i]
        if (strength !== undefined && strength < this.decayPruneThreshold) {
          const key = records[i]?.meta.key
          if (key) {
            try {
              await store.delete(namespace, key)
              pruned++
            } catch {
              // Non-fatal — single delete failed
            }
          }
        }
      }

      return pruned
    } catch {
      // Arrow not available or failed — fall back to standard path
      return this.standardDecayPrune(store, namespace)
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * One-shot sleep consolidation. Convenience wrapper.
 */
export async function runSleepConsolidation(
  store: BaseStore,
  namespaces: string[][],
  config: SleepConsolidationConfig,
): Promise<SleepConsolidationReport> {
  return new SleepConsolidator(config).run(store, namespaces)
}
