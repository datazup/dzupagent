/**
 * SharedMemoryNamespace — in-memory shared namespace for multi-agent collaboration.
 *
 * Provides a last-writer-wins key-value store with:
 * - Monotonically increasing version tracking per key
 * - Optional access control (allowedWriters whitelist)
 * - Optional audit trail
 * - Max-entries eviction (oldest by updatedAt)
 * - Simple substring search across keys and values
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SharedEntry {
  key: string
  value: Record<string, unknown>
  /** Agent that last wrote this entry */
  writtenBy: string
  /** Monotonically increasing version per key */
  version: number
  /** Timestamp of last write */
  updatedAt: number
  /** Creation timestamp */
  createdAt: number
}

export interface SharedNamespaceConfig {
  /** Namespace path (e.g., ['shared', 'project-123']) */
  namespace: string[]
  /** Agents allowed to write (empty = all allowed) */
  allowedWriters?: string[]
  /** Max entries in the namespace (default: 1000) */
  maxEntries?: number
  /** Enable audit trail (default: false) */
  enableAudit?: boolean
}

export interface AuditEntry {
  action: 'put' | 'delete'
  key: string
  agentId: string
  timestamp: number
  previousVersion?: number
}

export interface SharedNamespaceStats {
  entryCount: number
  writerCount: number
  lastWriteAt: number | null
  auditSize: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SharedMemoryNamespace {
  private readonly entries = new Map<string, SharedEntry>()
  private readonly audit: AuditEntry[] = []
  private readonly config: Required<Pick<SharedNamespaceConfig, 'maxEntries' | 'enableAudit'>> &
    SharedNamespaceConfig

  constructor(config: SharedNamespaceConfig) {
    this.config = {
      ...config,
      maxEntries: config.maxEntries ?? 1000,
      enableAudit: config.enableAudit ?? false,
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Write an entry (last-writer-wins with version bump). */
  put(agentId: string, key: string, value: Record<string, unknown>): SharedEntry {
    if (!this.canWrite(agentId)) {
      throw new Error(`Agent "${agentId}" is not allowed to write to this namespace`)
    }

    const now = Date.now()
    const existing = this.entries.get(key)
    const previousVersion = existing?.version

    const entry: SharedEntry = {
      key,
      value,
      writtenBy: agentId,
      version: existing ? existing.version + 1 : 1,
      updatedAt: now,
      createdAt: existing ? existing.createdAt : now,
    }

    this.entries.set(key, entry)

    if (this.config.enableAudit) {
      this.audit.push({
        action: 'put',
        key,
        agentId,
        timestamp: now,
        previousVersion,
      })
    }

    this.evictIfNeeded()

    return entry
  }

  /** Read an entry. */
  get(key: string): SharedEntry | null {
    return this.entries.get(key) ?? null
  }

  /** Delete an entry. Returns true if the entry existed and was removed. */
  delete(agentId: string, key: string): boolean {
    if (!this.canWrite(agentId)) {
      throw new Error(`Agent "${agentId}" is not allowed to write to this namespace`)
    }

    const existing = this.entries.get(key)
    if (!existing) return false

    this.entries.delete(key)

    if (this.config.enableAudit) {
      this.audit.push({
        action: 'delete',
        key,
        agentId,
        timestamp: Date.now(),
        previousVersion: existing.version,
      })
    }

    return true
  }

  /** Search entries by case-insensitive substring match on key and JSON-serialized value. */
  search(query: string, limit = 10): SharedEntry[] {
    const lower = query.toLowerCase()
    const results: SharedEntry[] = []

    for (const entry of this.entries.values()) {
      if (results.length >= limit) break
      const haystack = `${entry.key} ${JSON.stringify(entry.value)}`.toLowerCase()
      if (haystack.includes(lower)) {
        results.push(entry)
      }
    }

    return results
  }

  /** List all entries. */
  list(): SharedEntry[] {
    return Array.from(this.entries.values())
  }

  /** Get audit trail entries, optionally filtered by key. */
  getAudit(key?: string): AuditEntry[] {
    if (!this.config.enableAudit) return []
    if (key === undefined) return [...this.audit]
    return this.audit.filter((a) => a.key === key)
  }

  /** Get namespace statistics. */
  stats(): SharedNamespaceStats {
    const writers = new Set<string>()
    let lastWriteAt: number | null = null

    for (const entry of this.entries.values()) {
      writers.add(entry.writtenBy)
      if (lastWriteAt === null || entry.updatedAt > lastWriteAt) {
        lastWriteAt = entry.updatedAt
      }
    }

    return {
      entryCount: this.entries.size,
      writerCount: writers.size,
      lastWriteAt,
      auditSize: this.audit.length,
    }
  }

  /** Check if an agent has write access. */
  canWrite(agentId: string): boolean {
    const writers = this.config.allowedWriters
    if (!writers || writers.length === 0) return true
    return writers.includes(agentId)
  }

  /** Clear all entries and audit trail (admin operation). */
  clear(): void {
    this.entries.clear()
    this.audit.length = 0
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Evict oldest entries (by updatedAt) when maxEntries is exceeded. */
  private evictIfNeeded(): void {
    if (this.entries.size <= this.config.maxEntries) return

    // Sort entries by updatedAt ascending (oldest first)
    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => a.updatedAt - b.updatedAt,
    )

    const toEvict = this.entries.size - this.config.maxEntries
    for (let i = 0; i < toEvict; i++) {
      this.entries.delete(sorted[i]!.key)
    }
  }
}
