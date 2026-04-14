/**
 * Staged memory writer — implements a three-stage workflow for memory persistence.
 *
 * Stage 1 (captured):  Raw observation extracted from conversation.
 * Stage 2 (candidate): Promoted after dedup and relevance check.
 * Stage 3 (confirmed): Auto-confirmed (benign) or human-confirmed (sensitive).
 *
 * Records may also be explicitly rejected at any stage.
 */

export type MemoryStage = 'captured' | 'candidate' | 'confirmed' | 'rejected'

export interface StagedRecord {
  key: string
  namespace: string
  scope: Record<string, string>
  value: Record<string, unknown>
  stage: MemoryStage
  /** Why this record was captured */
  captureReason?: string | undefined
  /** Confidence score 0-1 (from observation extractor or explicit) */
  confidence: number
  createdAt: number
  promotedAt?: number | undefined
  confirmedAt?: number | undefined
}

export interface StagedWriterConfig {
  /** Auto-promote threshold: records above this confidence become candidates (default: 0.7) */
  autoPromoteThreshold: number
  /** Auto-confirm threshold: candidates above this confidence auto-confirm (default: 0.9) */
  autoConfirmThreshold: number
  /** Max pending records before oldest are pruned (default: 100) */
  maxPending: number
}

const DEFAULT_CONFIG: StagedWriterConfig = {
  autoPromoteThreshold: 0.7,
  autoConfirmThreshold: 0.9,
  maxPending: 100,
}

export class StagedWriter {
  private pending: Map<string, StagedRecord> = new Map()
  private readonly config: StagedWriterConfig

  constructor(config?: Partial<StagedWriterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Capture a raw observation. Auto-promotes if above threshold. */
  capture(
    record: Omit<StagedRecord, 'stage' | 'createdAt'>,
  ): StagedRecord {
    this.pruneIfNeeded()

    const staged: StagedRecord = {
      ...record,
      stage: 'captured',
      createdAt: Date.now(),
    }

    this.pending.set(staged.key, staged)

    // Auto-promote high-confidence records
    if (staged.confidence >= this.config.autoPromoteThreshold) {
      this.promote(staged.key)
    }

    return this.pending.get(staged.key) ?? staged
  }

  /** Promote a captured record to candidate stage. */
  promote(key: string): StagedRecord | null {
    const record = this.pending.get(key)
    if (!record || record.stage !== 'captured') return null

    record.stage = 'candidate'
    record.promotedAt = Date.now()

    // Auto-confirm very high-confidence candidates
    if (record.confidence >= this.config.autoConfirmThreshold) {
      this.confirm(key)
    }

    return this.pending.get(key) ?? record
  }

  /** Confirm a candidate (makes it ready for persistence). */
  confirm(key: string): StagedRecord | null {
    const record = this.pending.get(key)
    if (!record || record.stage !== 'candidate') return null

    record.stage = 'confirmed'
    record.confirmedAt = Date.now()
    return record
  }

  /** Reject a record at any stage. */
  reject(key: string): StagedRecord | null {
    const record = this.pending.get(key)
    if (!record) return null

    record.stage = 'rejected'
    return record
  }

  /** Get all records at a specific stage. */
  getByStage(stage: MemoryStage): StagedRecord[] {
    const results: StagedRecord[] = []
    for (const record of this.pending.values()) {
      if (record.stage === stage) results.push(record)
    }
    return results
  }

  /** Get all pending (non-confirmed, non-rejected) records. */
  getPending(): StagedRecord[] {
    const results: StagedRecord[] = []
    for (const record of this.pending.values()) {
      if (record.stage === 'captured' || record.stage === 'candidate') {
        results.push(record)
      }
    }
    return results
  }

  /** Flush all confirmed records (returns them and removes from pending). */
  flushConfirmed(): StagedRecord[] {
    const confirmed: StagedRecord[] = []
    for (const [key, record] of this.pending) {
      if (record.stage === 'confirmed') {
        confirmed.push(record)
        this.pending.delete(key)
      }
    }
    return confirmed
  }

  /** Get a record by key. */
  get(key: string): StagedRecord | undefined {
    return this.pending.get(key)
  }

  // --- Internals ---

  /** Remove oldest non-terminal records when capacity is exceeded. */
  private pruneIfNeeded(): void {
    const activeCount = this.getPending().length
    if (activeCount < this.config.maxPending) return

    // Also remove rejected records first
    for (const [key, record] of this.pending) {
      if (record.stage === 'rejected') {
        this.pending.delete(key)
      }
    }

    // If still over limit, remove oldest captured records
    if (this.getPending().length >= this.config.maxPending) {
      const captured = this.getByStage('captured')
        .sort((a, b) => a.createdAt - b.createdAt)

      const toRemove = captured.length - Math.floor(this.config.maxPending * 0.8)
      for (let i = 0; i < toRemove && i < captured.length; i++) {
        this.pending.delete(captured[i]!.key)
      }
    }
  }
}
