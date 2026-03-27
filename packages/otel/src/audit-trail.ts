/**
 * AuditTrail — tamper-evident audit log with hash-chain integrity.
 *
 * Each audit entry is linked to the previous via a SHA-256 hash chain,
 * allowing verification that no entries have been modified or removed.
 *
 * Subscribes to DzipEventBus and maps events to audit categories:
 * - agent:started/completed/failed -> agent_lifecycle
 * - tool:called/result/error -> tool_execution
 * - memory:written -> memory_mutation
 * - approval:* -> approval_action
 * - budget:* -> cost_threshold
 *
 * @example
 * ```ts
 * const trail = new AuditTrail()
 * trail.attach(bus)
 * // ... agent runs ...
 * const { valid } = trail.verifyChain()
 * ```
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DzipEventBus, DzipEvent } from '@dzipagent/core'

// ------------------------------------------------------------------ Types

export type AuditCategory =
  | 'agent_lifecycle'
  | 'tool_execution'
  | 'memory_mutation'
  | 'approval_action'
  | 'safety_event'
  | 'cost_threshold'
  | 'config_change'

export interface AuditEntry {
  id: string
  seq: number
  timestamp: Date
  category: AuditCategory
  agentId?: string
  runId?: string
  action: string
  details: Record<string, unknown>
  previousHash: string
  hash: string
}

export interface AuditStore {
  append(entry: AuditEntry): Promise<void>
  getByRun(runId: string): Promise<AuditEntry[]>
  getByAgent(agentId: string, limit?: number): Promise<AuditEntry[]>
  getByCategory(category: AuditCategory, limit?: number): Promise<AuditEntry[]>
  getAll(limit?: number, offset?: number): Promise<AuditEntry[]>
  getLatest(): Promise<AuditEntry | undefined>
  prune(beforeDate: Date): Promise<number>
}

export interface AuditTrailConfig {
  store?: AuditStore
  /** Which categories to record (default: all) */
  categories?: AuditCategory[]
  /** Auto-prune entries older than this many days (default: 90) */
  retentionDays?: number
}

// --------------------------------------------------- Hash computation

const ZERO_HASH = '0'.repeat(64)

function computeHash(entry: {
  seq: number
  timestamp: Date
  category: string
  action: string
  details: Record<string, unknown>
  previousHash: string
}): string {
  const data = `${entry.seq}|${entry.timestamp.toISOString()}|${entry.category}|${entry.action}|${JSON.stringify(entry.details)}|${entry.previousHash}`
  return createHash('sha256').update(data).digest('hex')
}

// ------------------------------------------------- InMemoryAuditStore

export class InMemoryAuditStore implements AuditStore {
  private readonly _entries: AuditEntry[] = []

  async append(entry: AuditEntry): Promise<void> {
    this._entries.push(entry)
  }

  async getByRun(runId: string): Promise<AuditEntry[]> {
    return this._entries.filter((e) => e.runId === runId)
  }

  async getByAgent(agentId: string, limit?: number): Promise<AuditEntry[]> {
    const filtered = this._entries.filter((e) => e.agentId === agentId)
    return limit !== undefined ? filtered.slice(0, limit) : filtered
  }

  async getByCategory(category: AuditCategory, limit?: number): Promise<AuditEntry[]> {
    const filtered = this._entries.filter((e) => e.category === category)
    return limit !== undefined ? filtered.slice(0, limit) : filtered
  }

  async getAll(limit?: number, offset?: number): Promise<AuditEntry[]> {
    const start = offset ?? 0
    const end = limit !== undefined ? start + limit : undefined
    return this._entries.slice(start, end)
  }

  async getLatest(): Promise<AuditEntry | undefined> {
    return this._entries.length > 0
      ? this._entries[this._entries.length - 1]
      : undefined
  }

  async prune(beforeDate: Date): Promise<number> {
    const beforeMs = beforeDate.getTime()
    let pruned = 0
    let i = 0
    while (i < this._entries.length) {
      const entry = this._entries[i]
      if (entry && entry.timestamp.getTime() < beforeMs) {
        this._entries.splice(i, 1)
        pruned++
      } else {
        i++
      }
    }
    return pruned
  }
}

// ---------------------------------------------------- Event mapping

interface EventMapping {
  category: AuditCategory
  action: string
  extractDetails: (event: DzipEvent) => Record<string, unknown>
  extractIds: (event: DzipEvent) => { agentId?: string; runId?: string }
}

function mapEvent(event: DzipEvent): EventMapping | undefined {
  switch (event.type) {
    case 'agent:started':
      return {
        category: 'agent_lifecycle',
        action: 'agent:started',
        extractDetails: () => ({}),
        extractIds: () => ({ agentId: event.agentId, runId: event.runId }),
      }
    case 'agent:completed':
      return {
        category: 'agent_lifecycle',
        action: 'agent:completed',
        extractDetails: () => ({ durationMs: event.durationMs }),
        extractIds: () => ({ agentId: event.agentId, runId: event.runId }),
      }
    case 'agent:failed':
      return {
        category: 'agent_lifecycle',
        action: 'agent:failed',
        extractDetails: () => ({ errorCode: event.errorCode, message: event.message }),
        extractIds: () => ({ agentId: event.agentId, runId: event.runId }),
      }
    case 'tool:called':
      return {
        category: 'tool_execution',
        action: `tool:called:${event.toolName}`,
        extractDetails: () => ({ toolName: event.toolName }),
        extractIds: () => ({}),
      }
    case 'tool:result':
      return {
        category: 'tool_execution',
        action: `tool:result:${event.toolName}`,
        extractDetails: () => ({ toolName: event.toolName, durationMs: event.durationMs }),
        extractIds: () => ({}),
      }
    case 'tool:error':
      return {
        category: 'tool_execution',
        action: `tool:error:${event.toolName}`,
        extractDetails: () => ({ toolName: event.toolName, errorCode: event.errorCode, message: event.message }),
        extractIds: () => ({}),
      }
    case 'memory:written':
      return {
        category: 'memory_mutation',
        action: 'memory:written',
        extractDetails: () => ({ namespace: event.namespace, key: event.key }),
        extractIds: () => ({}),
      }
    case 'approval:requested':
      return {
        category: 'approval_action',
        action: 'approval:requested',
        extractDetails: () => ({}),
        extractIds: () => ({ runId: event.runId }),
      }
    case 'approval:granted':
      return {
        category: 'approval_action',
        action: 'approval:granted',
        extractDetails: () => ({ approvedBy: event.approvedBy }),
        extractIds: () => ({ runId: event.runId }),
      }
    case 'approval:rejected':
      return {
        category: 'approval_action',
        action: 'approval:rejected',
        extractDetails: () => ({ reason: event.reason }),
        extractIds: () => ({ runId: event.runId }),
      }
    case 'budget:warning':
      return {
        category: 'cost_threshold',
        action: 'budget:warning',
        extractDetails: () => ({ level: event.level, percent: event.usage.percent }),
        extractIds: () => ({}),
      }
    case 'budget:exceeded':
      return {
        category: 'cost_threshold',
        action: 'budget:exceeded',
        extractDetails: () => ({ reason: event.reason, percent: event.usage.percent }),
        extractIds: () => ({}),
      }
    default:
      return undefined
  }
}

// ---------------------------------------------------------- AuditTrail

export class AuditTrail {
  private readonly _store: AuditStore
  private readonly _categories: Set<AuditCategory> | undefined
  private readonly _retentionDays: number
  private _seq = 0
  private _lastHash: string = ZERO_HASH
  private _unsubscribes: Array<() => void> = []

  constructor(config?: AuditTrailConfig) {
    this._store = config?.store ?? new InMemoryAuditStore()
    this._categories = config?.categories ? new Set(config.categories) : undefined
    this._retentionDays = config?.retentionDays ?? 90
  }

  // ------------------------------------------------------ Lifecycle

  /**
   * Attach to a DzipEventBus. Maps events to audit entries.
   */
  attach(eventBus: DzipEventBus): void {
    this.detach()

    this._unsubscribes.push(
      eventBus.onAny((event) => {
        try {
          const mapping = mapEvent(event)
          if (!mapping) return
          if (this._categories && !this._categories.has(mapping.category)) return

          const details = mapping.extractDetails(event)
          const ids = mapping.extractIds(event)

          // Fire-and-forget — audit failures are non-fatal
          void this._appendEntry(mapping.category, mapping.action, details, ids.agentId, ids.runId)
        } catch {
          // Non-fatal
        }
      }),
    )
  }

  /**
   * Detach from the event bus.
   */
  detach(): void {
    for (const unsub of this._unsubscribes) {
      unsub()
    }
    this._unsubscribes = []
  }

  // --------------------------------------------------- Entry creation

  private async _appendEntry(
    category: AuditCategory,
    action: string,
    details: Record<string, unknown>,
    agentId?: string,
    runId?: string,
  ): Promise<void> {
    const seq = this._seq++
    const timestamp = new Date()
    const previousHash = this._lastHash

    const hash = computeHash({ seq, timestamp, category, action, details, previousHash })

    const entry: AuditEntry = {
      id: randomUUID(),
      seq,
      timestamp,
      category,
      agentId,
      runId,
      action,
      details,
      previousHash,
      hash,
    }

    this._lastHash = hash
    await this._store.append(entry)

    // Auto-prune if retention is configured
    if (this._retentionDays > 0 && seq % 100 === 99) {
      const cutoff = new Date(Date.now() - this._retentionDays * 24 * 60 * 60 * 1000)
      await this._store.prune(cutoff).catch(() => {
        // Non-fatal
      })
    }
  }

  // --------------------------------------------------- Verification

  /**
   * Verify hash chain integrity.
   * If entries are not provided, loads all from store.
   */
  verifyChain(entries?: AuditEntry[]): { valid: boolean; brokenAt?: number } {
    if (!entries || entries.length === 0) {
      return { valid: true }
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!

      // First entry must reference the zero hash
      if (i === 0 && entry.previousHash !== ZERO_HASH) {
        return { valid: false, brokenAt: 0 }
      }

      // Subsequent entries must reference previous entry's hash
      if (i > 0) {
        const prev = entries[i - 1]!
        if (entry.previousHash !== prev.hash) {
          return { valid: false, brokenAt: i }
        }
      }

      // Verify computed hash matches stored hash
      const expected = computeHash({
        seq: entry.seq,
        timestamp: entry.timestamp,
        category: entry.category,
        action: entry.action,
        details: entry.details,
        previousHash: entry.previousHash,
      })
      if (entry.hash !== expected) {
        return { valid: false, brokenAt: i }
      }
    }

    return { valid: true }
  }

  // --------------------------------------------------- Query

  /**
   * Get audit entries with optional filtering.
   */
  async getEntries(filter?: {
    category?: AuditCategory
    agentId?: string
    runId?: string
    limit?: number
  }): Promise<AuditEntry[]> {
    if (filter?.runId) {
      return this._store.getByRun(filter.runId)
    }
    if (filter?.agentId) {
      return this._store.getByAgent(filter.agentId, filter.limit)
    }
    if (filter?.category) {
      return this._store.getByCategory(filter.category, filter.limit)
    }
    return this._store.getAll(filter?.limit)
  }

  /**
   * Get the underlying store for direct access.
   */
  getStore(): AuditStore {
    return this._store
  }
}
