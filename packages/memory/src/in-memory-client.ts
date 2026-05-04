/**
 * InMemoryMemoryClient — Map-backed `MemoryClient` for tests and dev.
 *
 * Lookup keys are `${namespace}:${stableScope}:${id}` where `stableScope`
 * is a JSON serialisation of the non-undefined scope fields in canonical
 * order. The same canonicalisation is applied during `get` so that scoped
 * reads filter on every supplied scope field.
 */

import type {
  MemoryClient,
  MemoryRecord,
  MemoryScope,
  MemoryQuery,
  MemoryChangeEvent,
  MemoryStats,
} from '@dzupagent/agent-types'

type ScopeField = 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'

const SCOPE_FIELDS: readonly ScopeField[] = [
  'tenantId',
  'workspaceId',
  'projectId',
  'taskId',
]

/** Canonicalise a scope so that equivalent scopes serialise identically. */
function serializeScope(scope: MemoryScope): string {
  const ordered: Record<string, string> = {}
  for (const field of SCOPE_FIELDS) {
    const value = scope[field]
    if (typeof value === 'string' && value.length > 0) {
      ordered[field] = value
    }
  }
  return JSON.stringify(ordered)
}

/** Build the storage key. */
function buildKey(namespace: string, scope: MemoryScope, id: string): string {
  return `${namespace}:${serializeScope(scope)}:${id}`
}

/** Test whether a candidate record matches every non-undefined field of a scope. */
function scopeMatches(candidate: MemoryScope, query: MemoryScope): boolean {
  for (const field of SCOPE_FIELDS) {
    const want = query[field]
    if (want === undefined) continue
    if (candidate[field] !== want) return false
  }
  return true
}

/** Channel key for subscribers — namespace + scope; subscribers pre-filter. */
function channelKey(namespace: string, scope: MemoryScope): string {
  return `${namespace}:${serializeScope(scope)}`
}

export class InMemoryMemoryClient implements MemoryClient {
  private readonly store = new Map<string, MemoryRecord>()
  private readonly listeners = new Map<string, Set<(e: MemoryChangeEvent) => void>>()

  async get(
    namespace: string,
    scope: MemoryScope,
    query?: MemoryQuery,
  ): Promise<MemoryRecord[]> {
    const matched: MemoryRecord[] = []
    for (const record of this.store.values()) {
      if (record.namespace !== namespace) continue
      if (!scopeMatches(record.scope, scope)) continue
      if (query?.search) {
        const needle = query.search.toLowerCase()
        if (!record.content.toLowerCase().includes(needle)) continue
      }
      matched.push(record)
    }

    matched.sort((a, b) => b.updatedAt - a.updatedAt)

    const offset = query?.offset ?? 0
    const limit = query?.limit ?? matched.length
    return matched.slice(offset, offset + limit)
  }

  async put(
    namespace: string,
    scope: MemoryScope,
    record: MemoryRecord,
  ): Promise<void> {
    const key = buildKey(namespace, scope, record.id)
    const existing = this.store.get(key)
    const now = Date.now()
    const persisted: MemoryRecord = {
      ...record,
      namespace,
      scope,
      createdAt: existing?.createdAt ?? record.createdAt ?? now,
      updatedAt: now,
    }
    this.store.set(key, persisted)
    this.emit(namespace, scope, {
      type: existing ? 'updated' : 'created',
      record: persisted,
    })
  }

  async delete(
    namespace: string,
    scope: MemoryScope,
    recordId: string,
  ): Promise<boolean> {
    const key = buildKey(namespace, scope, recordId)
    const existing = this.store.get(key)
    if (!existing) return false
    this.store.delete(key)
    this.emit(namespace, scope, { type: 'deleted', record: existing })
    return true
  }

  subscribe(
    namespace: string,
    scope: MemoryScope,
    listener: (event: MemoryChangeEvent) => void,
  ): () => void {
    const key = channelKey(namespace, scope)
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(key)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(key)
    }
  }

  async stats(): Promise<MemoryStats> {
    const namespaces = new Set<string>()
    for (const record of this.store.values()) {
      namespaces.add(record.namespace)
    }
    return {
      totalRecords: this.store.size,
      namespaces: Array.from(namespaces).sort(),
    }
  }

  /** Test helper: drop all stored records and listeners. */
  clear(): void {
    this.store.clear()
    this.listeners.clear()
  }

  private emit(
    namespace: string,
    scope: MemoryScope,
    event: MemoryChangeEvent,
  ): void {
    const key = channelKey(namespace, scope)
    const listeners = this.listeners.get(key)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Listener errors must not break the write path
      }
    }
  }
}
