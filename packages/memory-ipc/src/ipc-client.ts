/**
 * IpcMemoryClient — `MemoryClient` backed by an Arrow IPC endpoint.
 *
 * Two construction modes:
 *
 * 1. **Backing service (in-process).** Pass a `MemoryServiceLike` via
 *    `config.backingService`. The client performs CRUD directly against
 *    that service while still presenting the `MemoryClient` contract.
 *    Useful for tests and single-process deployments that nevertheless
 *    want to exercise the IPC code path.
 *
 * 2. **Remote endpoint (placeholder).** Pass `config.endpoint`. The client
 *    will eventually issue Arrow IPC requests over that endpoint. Until the
 *    wire protocol is finalised, calls in this mode throw
 *    `IpcNotConfiguredError` so misconfiguration is loud.
 */

// Structural copies of agent-types interfaces — memory-ipc is a leaf-primitive
// and cannot depend on agent-types (same layer). Consumers that want the
// canonical MemoryClient type should import from @dzupagent/agent-types directly.
export interface MemoryScope {
  tenantId: string
  workspaceId?: string
  projectId?: string
  taskId?: string
}

export interface MemoryQuery {
  limit?: number
  offset?: number
  filter?: Record<string, unknown>
  search?: string
}

export interface MemoryRecord {
  id: string
  namespace: string
  scope: MemoryScope
  content: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface MemoryClient {
  get(namespace: string, scope: MemoryScope, query?: MemoryQuery): Promise<MemoryRecord[]>
  put(namespace: string, scope: MemoryScope, record: MemoryRecord): Promise<void>
  delete(namespace: string, scope: MemoryScope, recordId: string): Promise<boolean>
}

import type { MemoryServiceLike } from './memory-service-ext.js'

export class IpcNotConfiguredError extends Error {
  constructor(method: string) {
    super(
      `IpcMemoryClient.${method} cannot run without a backingService. ` +
        `Remote IPC transport is not implemented yet — pass ` +
        `config.backingService to use the in-process path.`,
    )
    this.name = 'IpcNotConfiguredError'
  }
}

export interface IpcMemoryClientConfig {
  /** Remote endpoint URI. Reserved for future use. */
  endpoint?: string
  /** Optional request timeout in milliseconds. */
  timeoutMs?: number
  /**
   * In-process memory service to delegate CRUD to. Required while the
   * remote IPC transport is unimplemented.
   */
  backingService?: MemoryServiceLike
}

function scopeToRecord(scope: MemoryScope): Record<string, string> {
  const out: Record<string, string> = { tenantId: scope.tenantId }
  if (scope.workspaceId) out.workspaceId = scope.workspaceId
  if (scope.projectId) out.projectId = scope.projectId
  if (scope.taskId) out.taskId = scope.taskId
  return out
}

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

export class IpcMemoryClient implements MemoryClient {
  constructor(private readonly config: IpcMemoryClientConfig) {}

  async get(
    namespace: string,
    scope: MemoryScope,
    query?: MemoryQuery,
  ): Promise<MemoryRecord[]> {
    const svc = this.config.backingService
    if (!svc) throw new IpcNotConfiguredError('get')
    const flatScope = scopeToRecord(scope)
    let raw: Record<string, unknown>[]
    if (query?.search && typeof svc.search === 'function') {
      raw = await svc.search(namespace, flatScope, query.search, query.limit)
    } else {
      raw = await svc.get(namespace, flatScope)
    }
    const records = raw.map((r, idx) =>
      liftRecord(r, namespace, scope, `ipc-${idx}`),
    )
    const offset = query?.offset ?? 0
    const limit = query?.limit ?? records.length
    return records.slice(offset, offset + limit)
  }

  async put(
    namespace: string,
    scope: MemoryScope,
    record: MemoryRecord,
  ): Promise<void> {
    const svc = this.config.backingService
    if (!svc) throw new IpcNotConfiguredError('put')
    const flatScope = scopeToRecord(scope)
    const value: Record<string, unknown> = {
      text: record.content,
      ...record.metadata,
    }
    await svc.put(namespace, flatScope, record.id, value)
  }

  async delete(
    namespace: string,
    scope: MemoryScope,
    recordId: string,
  ): Promise<boolean> {
    const svc = this.config.backingService
    if (!svc) throw new IpcNotConfiguredError('delete')
    if (typeof svc.delete !== 'function') return false
    const flatScope = scopeToRecord(scope)
    const result = await svc.delete(namespace, flatScope, recordId)
    return result !== false
  }
}
