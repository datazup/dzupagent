/**
 * SharedMemoryNamespace — in-memory shared namespace for multi-agent collaboration.
 *
 * Provides a last-writer-wins key-value store with:
 * - Monotonically increasing version tracking per key
 * - Optional vector-clock-based causal ordering (CRDT merge)
 * - Optional access control (allowedWriters whitelist)
 * - Optional audit trail
 * - Max-entries eviction (oldest by updatedAt)
 * - Simple substring search across keys and values
 */

import { VectorClock } from './vector-clock.js'

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
  /** Serialized VectorClock for causal ordering (optional for backward compat) */
  vectorClock?: Record<string, number>
}

/** Result of merging remote entries into this namespace. */
export interface MergeReport {
  /** Number of remote entries accepted (overwrote local) */
  accepted: number
  /** Number of remote entries rejected (local was newer) */
  rejected: number
  /** Number of concurrent conflicts resolved via LWW tiebreak */
  conflicts: number
}

/** A conflict entry detected during merge (concurrent vector clocks). */
export interface ConflictEntry {
  key: string
  /** The entry that was kept (winner of LWW tiebreak) */
  kept: SharedEntry
  /** The entry that was discarded (loser of LWW tiebreak) */
  discarded: SharedEntry
  /** Timestamp when the conflict was detected */
  detectedAt: number
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
  private readonly detectedConflicts: ConflictEntry[] = []
  private readonly vectorClocks = new Map<string, VectorClock>()
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

  /** Write an entry (last-writer-wins with version bump + vector clock). */
  put(agentId: string, key: string, value: Record<string, unknown>): SharedEntry {
    if (!this.canWrite(agentId)) {
      throw new Error(`Agent "${agentId}" is not allowed to write to this namespace`)
    }

    const now = Date.now()
    const existing = this.entries.get(key)
    const previousVersion = existing?.version

    // Increment vector clock for this agent on this key
    const existingClock = this.vectorClocks.get(key) ?? new VectorClock()
    const newClock = existingClock.increment(agentId)
    this.vectorClocks.set(key, newClock)

    const entry: SharedEntry = {
      key,
      value,
      writtenBy: agentId,
      version: existing ? existing.version + 1 : 1,
      updatedAt: now,
      createdAt: existing ? existing.createdAt : now,
      vectorClock: newClock.toJSON(),
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

  /**
   * Merge remote entries into this namespace using vector clock comparison.
   *
   * For each remote entry:
   * - Remote `after` local  -> accept remote (overwrite local)
   * - Remote `before` local -> reject remote (keep local)
   * - `concurrent`          -> LWW tiebreak using updatedAt (most recent wins)
   * - `equal`               -> no-op
   *
   * Entries without vectorClock are compared using version numbers (LWW fallback).
   */
  merge(remoteEntries: SharedEntry[]): MergeReport {
    let accepted = 0
    let rejected = 0
    let conflicts = 0

    for (const remote of remoteEntries) {
      const local = this.entries.get(remote.key)

      if (!local) {
        // No local entry — accept remote unconditionally
        this.entries.set(remote.key, remote)
        if (remote.vectorClock) {
          this.vectorClocks.set(remote.key, VectorClock.fromJSON(remote.vectorClock))
        }
        accepted++
        continue
      }

      // Both have vector clocks — use causal comparison
      if (local.vectorClock && remote.vectorClock) {
        const localClock = VectorClock.fromJSON(local.vectorClock)
        const remoteClock = VectorClock.fromJSON(remote.vectorClock)
        const comparison = remoteClock.compare(localClock)

        switch (comparison) {
          case 'after': {
            this.entries.set(remote.key, remote)
            this.vectorClocks.set(remote.key, remoteClock)
            accepted++
            break
          }
          case 'before': {
            rejected++
            break
          }
          case 'equal': {
            // No-op — identical state
            break
          }
          case 'concurrent': {
            conflicts++
            // LWW tiebreak: keep the entry with the most recent updatedAt
            if (remote.updatedAt >= local.updatedAt) {
              const mergedClock = localClock.merge(remoteClock)
              const winner = { ...remote, vectorClock: mergedClock.toJSON() }
              this.entries.set(remote.key, winner)
              this.vectorClocks.set(remote.key, mergedClock)
              this.detectedConflicts.push({
                key: remote.key,
                kept: winner,
                discarded: local,
                detectedAt: Date.now(),
              })
              accepted++
            } else {
              const mergedClock = localClock.merge(remoteClock)
              const winner = { ...local, vectorClock: mergedClock.toJSON() }
              this.entries.set(local.key, winner)
              this.vectorClocks.set(local.key, mergedClock)
              this.detectedConflicts.push({
                key: remote.key,
                kept: winner,
                discarded: remote,
                detectedAt: Date.now(),
              })
              rejected++
            }
            break
          }
        }
      } else {
        // Fallback: at least one entry lacks a vector clock — use version comparison (LWW)
        if (remote.version > local.version) {
          this.entries.set(remote.key, remote)
          if (remote.vectorClock) {
            this.vectorClocks.set(remote.key, VectorClock.fromJSON(remote.vectorClock))
          }
          accepted++
        } else if (remote.version < local.version) {
          rejected++
        } else {
          // Same version — tiebreak on updatedAt
          if (remote.updatedAt > local.updatedAt) {
            this.entries.set(remote.key, remote)
            if (remote.vectorClock) {
              this.vectorClocks.set(remote.key, VectorClock.fromJSON(remote.vectorClock))
            }
            accepted++
          } else {
            rejected++
          }
        }
      }
    }

    return { accepted, rejected, conflicts }
  }

  /** Return all conflict entries detected during merge (concurrent vector clocks). */
  getConflicts(): ConflictEntry[] {
    return [...this.detectedConflicts]
  }

  /** Clear all entries and audit trail (admin operation). */
  clear(): void {
    this.entries.clear()
    this.audit.length = 0
    this.detectedConflicts.length = 0
    this.vectorClocks.clear()
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
