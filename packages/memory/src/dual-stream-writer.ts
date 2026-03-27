/**
 * Dual-stream write pipeline (MAGMA-inspired).
 *
 * Fast path: immediate store with cheap checks (sanitizer, PII regex). <50ms target.
 * Slow path: batched async processing (LLM dedup, graph updates, decay pruning).
 *
 * Records are always persisted on the fast path. The slow path is enrichment-only,
 * so failures there never cause data loss.
 */
import type { MemoryService } from './memory-service.js'
import { sanitizeMemoryContent } from './memory-sanitizer.js'
import { composePolicies, defaultWritePolicy, type WritePolicy } from './write-policy.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DualStreamConfig {
  /** Memory service for storage */
  memoryService: MemoryService
  /** Namespace for writes */
  namespace: string
  /** Scope for writes */
  scope: Record<string, string>
  /** Write policies for fast-path checking (default: [defaultWritePolicy]) */
  policies?: WritePolicy[]
  /** Batch size before triggering slow path (default: 10) */
  batchSize?: number
  /** Max delay before forced flush in ms (default: 60_000) */
  maxDelayMs?: number
  /** Callback for slow-path processing. If not provided, records just accumulate. */
  onSlowPath?: (records: PendingRecord[]) => Promise<void>
  /** Whether to reject unsafe content on fast path (default: true) */
  rejectUnsafe?: boolean
}

export interface PendingRecord {
  key: string
  value: Record<string, unknown>
  ingestedAt: number
}

export interface IngestResult {
  stored: boolean
  rejected: boolean
  rejectionReason?: string
  pendingBatchSize: number
}

// ---------------------------------------------------------------------------
// DualStreamWriter
// ---------------------------------------------------------------------------

export class DualStreamWriter {
  private pending: PendingRecord[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly config: Required<Pick<DualStreamConfig, 'batchSize' | 'maxDelayMs' | 'rejectUnsafe'>>
  private readonly policy: WritePolicy
  private readonly memoryService: MemoryService
  private readonly namespace: string
  private readonly scope: Record<string, string>
  private readonly onSlowPath?: (records: PendingRecord[]) => Promise<void>

  constructor(cfg: DualStreamConfig) {
    this.memoryService = cfg.memoryService
    this.namespace = cfg.namespace
    this.scope = cfg.scope
    this.onSlowPath = cfg.onSlowPath
    this.config = {
      batchSize: cfg.batchSize ?? 10,
      maxDelayMs: cfg.maxDelayMs ?? 60_000,
      rejectUnsafe: cfg.rejectUnsafe ?? true,
    }

    const policies = cfg.policies ?? [defaultWritePolicy]
    this.policy = policies.length === 1
      ? policies[0]!
      : composePolicies(...policies)
  }

  // ---- Fast path -----------------------------------------------------------

  async ingest(key: string, value: Record<string, unknown>): Promise<IngestResult> {
    // 1. Sanitize content (regex only, zero-LLM)
    if (this.config.rejectUnsafe) {
      const textContent = typeof value['text'] === 'string'
        ? value['text']
        : JSON.stringify(value)
      const sanitizeResult = sanitizeMemoryContent(textContent)
      if (!sanitizeResult.safe) {
        return {
          stored: false,
          rejected: true,
          rejectionReason: sanitizeResult.threats.join('; '),
          pendingBatchSize: this.pending.length,
        }
      }
    }

    // 2. Run write policy
    const action = this.policy.evaluate(value)
    if (action === 'reject') {
      return {
        stored: false,
        rejected: true,
        rejectionReason: `policy:${this.policy.name}`,
        pendingBatchSize: this.pending.length,
      }
    }

    // 3. Store via MemoryService (non-fatal — MemoryService catches internally)
    await this.memoryService.put(this.namespace, this.scope, key, value)

    // 4. Queue for slow-path processing
    this.pending.push({ key, value, ingestedAt: Date.now() })

    // 5. Auto-flush if batch size reached
    if (this.pending.length >= this.config.batchSize) {
      // Fire-and-forget — flush errors are non-fatal
      void this.flush().catch(() => {})
    } else if (this.flushTimer === null) {
      // 6. Start delayed flush timer on first pending record after a flush
      this.flushTimer = setTimeout(() => {
        void this.flush().catch(() => {})
      }, this.config.maxDelayMs)
    }

    return {
      stored: true,
      rejected: false,
      pendingBatchSize: this.pending.length,
    }
  }

  // ---- Slow path -----------------------------------------------------------

  async flush(): Promise<{ processed: number }> {
    // Grab and clear pending batch atomically
    const batch = this.pending
    this.pending = []

    // Cancel flush timer
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (batch.length === 0) {
      return { processed: 0 }
    }

    // Invoke slow-path callback if configured
    if (this.onSlowPath) {
      try {
        await this.onSlowPath(batch)
      } catch {
        // Non-fatal — records are already persisted via fast path.
        // Slow path is enrichment only; data is safe.
      }
    }

    return { processed: batch.length }
  }

  // ---- Accessors -----------------------------------------------------------

  /** Number of records pending slow-path processing */
  get pendingCount(): number {
    return this.pending.length
  }

  /** Get pending records (shallow copy) */
  getPending(): ReadonlyArray<PendingRecord> {
    return [...this.pending]
  }

  /** Clear pending records without processing */
  clearPending(): void {
    this.pending = []
  }

  /** Stop the flush timer and release resources */
  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}
