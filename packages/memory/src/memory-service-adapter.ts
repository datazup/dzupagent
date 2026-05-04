/**
 * memoryServiceToClient — bridge a `MemoryService`-shaped object to
 * the `MemoryClient` contract defined in `@dzupagent/agent-types`.
 *
 * The legacy `MemoryService` API uses `Record<string, string>` scopes and
 * stores arbitrary `Record<string, unknown>` values. This adapter normalises
 * those into the `MemoryScope` / `MemoryRecord` shape expected by callers
 * of the `MemoryClient` interface.
 */

import type {
  MemoryClient,
  MemoryRecord,
  MemoryScope,
  MemoryQuery,
} from '@dzupagent/agent-types'

/**
 * Minimal shape used by the adapter. Matches `MemoryServiceLike` from
 * `@dzupagent/memory-ipc` but redeclared here so this module does not need
 * to import from the IPC package.
 */
export interface MemoryServiceLike {
  get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]>
  put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void>
  delete?(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<boolean | void>
  search?(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>
}

/** Convert a `MemoryScope` into the flat `Record<string, string>` form. */
function scopeToRecord(scope: MemoryScope): Record<string, string> {
  const out: Record<string, string> = { tenantId: scope.tenantId }
  if (scope.workspaceId) out.workspaceId = scope.workspaceId
  if (scope.projectId) out.projectId = scope.projectId
  if (scope.taskId) out.taskId = scope.taskId
  return out
}

/** Best-effort lift of an opaque legacy record into a `MemoryRecord`. */
function liftRecord(
  raw: Record<string, unknown>,
  namespace: string,
  scope: MemoryScope,
  fallbackId: string,
): MemoryRecord {
  const id =
    typeof raw['id'] === 'string'
      ? (raw['id'] as string)
      : typeof raw['key'] === 'string'
        ? (raw['key'] as string)
        : fallbackId
  const content =
    typeof raw['text'] === 'string'
      ? (raw['text'] as string)
      : typeof raw['content'] === 'string'
        ? (raw['content'] as string)
        : JSON.stringify(raw)
  const createdAt =
    typeof raw['createdAt'] === 'number' ? (raw['createdAt'] as number) : Date.now()
  const updatedAt =
    typeof raw['updatedAt'] === 'number' ? (raw['updatedAt'] as number) : createdAt

  const metadata: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'id' || k === 'key' || k === 'text' || k === 'content') continue
    if (k === 'createdAt' || k === 'updatedAt') continue
    metadata[k] = v
  }

  const record: MemoryRecord = {
    id,
    namespace,
    scope,
    content,
    createdAt,
    updatedAt,
  }
  if (Object.keys(metadata).length > 0) record.metadata = metadata
  return record
}

/** Wrap a `MemoryService`-shaped object as a `MemoryClient`. */
export function memoryServiceToClient(svc: MemoryServiceLike): MemoryClient {
  return {
    async get(
      namespace: string,
      scope: MemoryScope,
      query?: MemoryQuery,
    ): Promise<MemoryRecord[]> {
      const flatScope = scopeToRecord(scope)
      let raw: Record<string, unknown>[]
      if (query?.search && typeof svc.search === 'function') {
        raw = await svc.search(namespace, flatScope, query.search, query.limit)
      } else {
        raw = await svc.get(namespace, flatScope)
      }
      const records = raw.map((r, idx) =>
        liftRecord(r, namespace, scope, `legacy-${idx}`),
      )
      const offset = query?.offset ?? 0
      const limit = query?.limit ?? records.length
      return records.slice(offset, offset + limit)
    },

    async put(
      namespace: string,
      scope: MemoryScope,
      record: MemoryRecord,
    ): Promise<void> {
      const flatScope = scopeToRecord(scope)
      const value: Record<string, unknown> = {
        text: record.content,
        ...record.metadata,
      }
      await svc.put(namespace, flatScope, record.id, value)
    },

    async delete(
      namespace: string,
      scope: MemoryScope,
      recordId: string,
    ): Promise<boolean> {
      if (typeof svc.delete !== 'function') return false
      const flatScope = scopeToRecord(scope)
      const result = await svc.delete(namespace, flatScope, recordId)
      return result !== false
    },
  }
}
