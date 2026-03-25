/**
 * MemorySpaceManager — Multi-agent shared memory spaces.
 *
 * Manages the lifecycle of shared memory spaces: creation, joining, leaving,
 * data sharing (push / pull-request), querying, retention enforcement,
 * and event-driven subscriptions.
 *
 * Each space is backed by a dedicated namespace (`space:{spaceId}`) within
 * the underlying MemoryService. Space metadata lives in the `__spaces` namespace,
 * and pending pull-requests live in `__pending_shares`.
 *
 * Usage:
 *   const manager = new MemorySpaceManager({ memoryService })
 *   const space = await manager.create({ name: 'team-knowledge', owner: 'forge://acme/planner' })
 *   await manager.join(space.id, 'forge://acme/executor')
 *   await manager.share({ from: 'forge://acme/planner', spaceId: space.id, key: 'k1', value: { text: 'hi' }, mode: 'push' })
 */

import { randomUUID } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import { ProvenanceWriter } from '../provenance/provenance-writer.js'
import { HLC } from '../crdt/hlc.js'
import { CRDTResolver } from '../crdt/crdt-resolver.js'
import type { LWWMap } from '../crdt/types.js'
import type {
  SharedMemorySpace,
  SharedMemoryEvent,
  MemoryShareRequest,
  PendingShareRequest,
  SpacePermission,
  ConflictStrategy,
  RetentionPolicy,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPACES_NAMESPACE = '__spaces'
const PENDING_NAMESPACE = '__pending_shares'
const SPACE_SCOPE: Record<string, string> = { _ns: SPACES_NAMESPACE }
const PENDING_SCOPE: Record<string, string> = { _ns: PENDING_NAMESPACE }

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemorySpaceManagerConfig {
  memoryService: MemoryService
  /** Optional event handler for shared memory events */
  onEvent?: (event: SharedMemoryEvent) => void
  /** Node identifier for the HLC (defaults to a random UUID) */
  nodeId?: string
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class MemorySpaceManager {
  private readonly memoryService: MemoryService
  private readonly provenanceWriter: ProvenanceWriter
  private readonly onEvent: ((event: SharedMemoryEvent) => void) | undefined
  private readonly subscriptions: Map<string, Set<(event: SharedMemoryEvent) => void>> = new Map()
  private readonly crdtResolver: CRDTResolver
  private disposed = false

  constructor(config: MemorySpaceManagerConfig) {
    this.memoryService = config.memoryService
    this.provenanceWriter = new ProvenanceWriter(config.memoryService)
    this.onEvent = config.onEvent
    const hlc = new HLC(config.nodeId ?? randomUUID())
    this.crdtResolver = new CRDTResolver(hlc)
  }

  // -------------------------------------------------------------------------
  // Space lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a new shared memory space.
   */
  async create(params: {
    name: string
    owner: string
    conflictResolution?: ConflictStrategy
    retentionPolicy?: RetentionPolicy
  }): Promise<SharedMemorySpace> {
    const id = randomUUID()
    const now = new Date().toISOString()

    const space: SharedMemorySpace = {
      id,
      name: params.name,
      owner: params.owner,
      participants: [
        {
          agentUri: params.owner,
          permission: 'admin',
          joinedAt: now,
        },
      ],
      conflictResolution: params.conflictResolution ?? 'lww',
      createdAt: now,
    }

    if (params.retentionPolicy) {
      space.retentionPolicy = params.retentionPolicy
    }

    await this.memoryService.put(SPACES_NAMESPACE, SPACE_SCOPE, id, space as unknown as Record<string, unknown>)

    this.emit({ type: 'memory:space:created', spaceId: id, owner: params.owner })
    return space
  }

  /**
   * Join an existing shared memory space.
   */
  async join(
    spaceId: string,
    agentUri: string,
    permission: SpacePermission = 'read',
  ): Promise<void> {
    const space = await this.loadSpace(spaceId)
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`)
    }

    // Check if already a participant
    const existing = space.participants.find(p => p.agentUri === agentUri)
    if (existing) return

    space.participants.push({
      agentUri,
      permission,
      joinedAt: new Date().toISOString(),
    })

    await this.saveSpace(space)
    this.emit({ type: 'memory:space:joined', spaceId, agentUri, permission })
  }

  /**
   * Leave a shared memory space.
   */
  async leave(spaceId: string, agentUri: string): Promise<void> {
    const space = await this.loadSpace(spaceId)
    if (!space) return

    const idx = space.participants.findIndex(p => p.agentUri === agentUri)
    if (idx === -1) return

    space.participants.splice(idx, 1)
    await this.saveSpace(space)
    this.emit({ type: 'memory:space:left', spaceId, agentUri })
  }

  // -------------------------------------------------------------------------
  // Data sharing
  // -------------------------------------------------------------------------

  /**
   * Share data to a space.
   *
   * - `push`: direct write (requires read-write or admin permission)
   * - `pull-request`: creates a pending request for admin review
   * - `subscribe`: not implemented (placeholder for future)
   */
  async share(request: MemoryShareRequest): Promise<void> {
    const space = await this.loadSpace(request.spaceId)
    if (!space) {
      throw new Error(`Space not found: ${request.spaceId}`)
    }

    switch (request.mode) {
      case 'push':
        return this.handlePush(space, request)
      case 'pull-request':
        return this.handlePullRequest(space, request)
      case 'subscribe':
        throw new Error('Subscribe mode is not yet implemented')
    }
  }

  /**
   * Query records from a shared space.
   * Validates that the requesting agent has at least read permission.
   */
  async query(
    spaceId: string,
    agentUri: string,
    queryText?: string,
    limit = 10,
  ): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
    const space = await this.loadSpace(spaceId)
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`)
    }

    const participant = space.participants.find(p => p.agentUri === agentUri)
    if (!participant) {
      throw new Error(`Agent ${agentUri} is not a participant of space ${spaceId}`)
    }

    const scope = spaceScope(spaceId)

    if (queryText) {
      const results = await this.memoryService.search(
        spaceNamespace(spaceId),
        scope,
        queryText,
        limit,
      )
      return results.map((v, i) => ({ key: keyFromValue(v, i), value: v }))
    }

    const results = await this.memoryService.get(spaceNamespace(spaceId), scope)
    return results.slice(0, limit).map((v, i) => ({ key: keyFromValue(v, i), value: v }))
  }

  // -------------------------------------------------------------------------
  // Space queries
  // -------------------------------------------------------------------------

  /**
   * Get space metadata by ID.
   */
  async getSpace(spaceId: string): Promise<SharedMemorySpace | undefined> {
    const space = await this.loadSpace(spaceId)
    return space ?? undefined
  }

  /**
   * List all spaces, optionally filtered to those a specific agent participates in.
   */
  async listSpaces(agentUri?: string): Promise<SharedMemorySpace[]> {
    const raw = await this.memoryService.get(SPACES_NAMESPACE, SPACE_SCOPE)
    const spaces = raw
      .filter(isSpaceRecord)
      .map(toSpace)

    if (!agentUri) return spaces
    return spaces.filter(s => s.participants.some(p => p.agentUri === agentUri))
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Subscribe to events for a specific space.
   * Returns an object with an `unsubscribe()` method.
   */
  subscribe(
    spaceId: string,
    handler: (event: SharedMemoryEvent) => void,
  ): { unsubscribe: () => void } {
    if (!this.subscriptions.has(spaceId)) {
      this.subscriptions.set(spaceId, new Set())
    }
    this.subscriptions.get(spaceId)!.add(handler)

    return {
      unsubscribe: () => {
        const subs = this.subscriptions.get(spaceId)
        if (subs) {
          subs.delete(handler)
          if (subs.size === 0) this.subscriptions.delete(spaceId)
        }
      },
    }
  }

  // -------------------------------------------------------------------------
  // Pull-request review
  // -------------------------------------------------------------------------

  /**
   * Review a pending pull request.
   * Only agents with `admin` permission on the target space can review.
   */
  async reviewPullRequest(
    requestId: string,
    reviewerUri: string,
    approved: boolean,
  ): Promise<void> {
    const raw = await this.memoryService.get(PENDING_NAMESPACE, PENDING_SCOPE, requestId)
    if (raw.length === 0) {
      throw new Error(`Pending request not found: ${requestId}`)
    }
    const pending = raw[0] as unknown as PendingShareRequest

    const space = await this.loadSpace(pending.request.spaceId)
    if (!space) {
      throw new Error(`Space not found: ${pending.request.spaceId}`)
    }

    const reviewer = space.participants.find(p => p.agentUri === reviewerUri)
    if (!reviewer || reviewer.permission !== 'admin') {
      throw new Error(`Agent ${reviewerUri} does not have admin permission on space ${pending.request.spaceId}`)
    }

    const now = new Date().toISOString()
    const updated: PendingShareRequest = {
      ...pending,
      status: approved ? 'approved' : 'rejected',
      reviewedBy: reviewerUri,
      reviewedAt: now,
    }

    await this.memoryService.put(
      PENDING_NAMESPACE,
      PENDING_SCOPE,
      requestId,
      updated as unknown as Record<string, unknown>,
    )

    if (approved) {
      // Execute the write
      const scope = spaceScope(pending.request.spaceId)
      await this.provenanceWriter.put(
        spaceNamespace(pending.request.spaceId),
        scope,
        pending.request.key,
        pending.request.value,
        { agentUri: pending.request.from, source: 'shared' },
      )
      this.emit({
        type: 'memory:space:write',
        spaceId: pending.request.spaceId,
        key: pending.request.key,
        agentUri: pending.request.from,
      })
    }

    this.emit({
      type: 'memory:space:pull_reviewed',
      spaceId: pending.request.spaceId,
      requestId,
      status: approved ? 'approved' : 'rejected',
    })
  }

  /**
   * List pending pull requests for a space.
   */
  async listPendingRequests(spaceId: string): Promise<PendingShareRequest[]> {
    const raw = await this.memoryService.get(PENDING_NAMESPACE, PENDING_SCOPE)
    return raw
      .filter(isPendingRecord)
      .map(toPending)
      .filter(p => p.request.spaceId === spaceId && p.status === 'pending')
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Enforce retention policy on a space, pruning records that exceed limits.
   */
  async enforceRetention(spaceId: string): Promise<{ pruned: number }> {
    const space = await this.loadSpace(spaceId)
    if (!space || !space.retentionPolicy) {
      return { pruned: 0 }
    }

    const scope = spaceScope(spaceId)
    const records = await this.memoryService.get(spaceNamespace(spaceId), scope)

    let pruned = 0
    const now = Date.now()
    const policy = space.retentionPolicy

    // Sort by creation time (newest first) for maxRecords enforcement
    const withTime = records.map((r, i) => {
      const createdAt = extractCreatedAt(r)
      return { record: r, index: i, createdAt }
    })
    withTime.sort((a, b) => b.createdAt - a.createdAt)

    const toPrune = new Set<number>()

    // Prune by age
    if (policy.maxAgeMs != null) {
      for (const item of withTime) {
        if (item.createdAt > 0 && (now - item.createdAt) > policy.maxAgeMs) {
          toPrune.add(item.index)
        }
      }
    }

    // Prune by count (keep newest)
    if (policy.maxRecords != null) {
      for (let i = policy.maxRecords; i < withTime.length; i++) {
        const item = withTime[i]
        if (item) {
          toPrune.add(item.index)
        }
      }
    }

    // Execute pruning by writing empty values (tombstones)
    for (const idx of toPrune) {
      const record = records[idx]
      if (!record) continue
      const key = keyFromValue(record, idx)
      // Overwrite with a tombstone marker
      await this.memoryService.put(
        spaceNamespace(spaceId),
        scope,
        key,
        { _tombstone: true, _deletedAt: new Date().toISOString() },
      )
      pruned++
    }

    return { pruned }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Dispose all subscriptions and stop processing events.
   */
  dispose(): void {
    this.subscriptions.clear()
    this.disposed = true
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadSpace(spaceId: string): Promise<SharedMemorySpace | null> {
    const raw = await this.memoryService.get(SPACES_NAMESPACE, SPACE_SCOPE, spaceId)
    if (raw.length === 0) return null
    const record = raw[0]
    if (!record || !isSpaceRecord(record)) return null
    return toSpace(record)
  }

  private async saveSpace(space: SharedMemorySpace): Promise<void> {
    await this.memoryService.put(
      SPACES_NAMESPACE,
      SPACE_SCOPE,
      space.id,
      space as unknown as Record<string, unknown>,
    )
  }

  private async handlePush(space: SharedMemorySpace, request: MemoryShareRequest): Promise<void> {
    const participant = space.participants.find(p => p.agentUri === request.from)
    if (!participant) {
      throw new Error(`Agent ${request.from} is not a participant of space ${request.spaceId}`)
    }
    if (participant.permission === 'read') {
      throw new Error(`Agent ${request.from} does not have write permission on space ${request.spaceId}`)
    }

    const scope = spaceScope(request.spaceId)
    const ns = spaceNamespace(request.spaceId)

    if (space.conflictResolution === 'crdt') {
      await this.handleCRDTPush(space, request, ns, scope)
      return
    }

    await this.provenanceWriter.put(
      ns,
      scope,
      request.key,
      request.value,
      { agentUri: request.from, source: 'shared' },
    )

    this.emit({
      type: 'memory:space:write',
      spaceId: request.spaceId,
      key: request.key,
      agentUri: request.from,
    })
  }

  /**
   * Handle a CRDT push: wrap the value in an LWWMap, merge with any existing
   * value for the same key, store the merged result, and emit conflict event
   * when a merge occurs.
   */
  private async handleCRDTPush(
    space: SharedMemorySpace,
    request: MemoryShareRequest,
    ns: string,
    scope: Record<string, string>,
  ): Promise<void> {
    // Create an LWWMap from the incoming value
    const incomingMap = this.crdtResolver.createMap(request.value)

    // Check if there is an existing value for this key
    const existing = await this.memoryService.get(ns, scope, request.key)
    let finalValue: Record<string, unknown>
    let hadConflict = false

    if (existing.length > 0) {
      const existingRecord = existing[0]
      // Check if the existing record has _crdt metadata (was written via CRDT)
      const existingCrdt = existingRecord?.['_crdt']
      if (existingCrdt != null && typeof existingCrdt === 'object' && hasFields(existingCrdt)) {
        const existingMap: LWWMap = { fields: (existingCrdt as { fields: LWWMap['fields'] }).fields }
        const mergeResult = this.crdtResolver.mergeMaps(existingMap, incomingMap)
        finalValue = {
          ...this.crdtResolver.toObject(mergeResult.merged),
          _crdt: mergeResult.merged,
        }
        hadConflict = mergeResult.conflictsResolved > 0
      } else {
        // Existing record was not written via CRDT — treat incoming as authoritative
        finalValue = {
          ...this.crdtResolver.toObject(incomingMap),
          _crdt: incomingMap,
        }
      }
    } else {
      finalValue = {
        ...this.crdtResolver.toObject(incomingMap),
        _crdt: incomingMap,
      }
    }

    await this.provenanceWriter.put(
      ns,
      scope,
      request.key,
      finalValue,
      { agentUri: request.from, source: 'shared' },
    )

    this.emit({
      type: 'memory:space:write',
      spaceId: space.id,
      key: request.key,
      agentUri: request.from,
    })

    if (hadConflict) {
      this.emit({
        type: 'memory:space:conflict',
        spaceId: space.id,
        key: request.key,
        agentUri: request.from,
      })
    }
  }

  private async handlePullRequest(space: SharedMemorySpace, request: MemoryShareRequest): Promise<void> {
    const participant = space.participants.find(p => p.agentUri === request.from)
    if (!participant) {
      throw new Error(`Agent ${request.from} is not a participant of space ${request.spaceId}`)
    }

    const requestId = randomUUID()
    const pending: PendingShareRequest = {
      id: requestId,
      request,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }

    await this.memoryService.put(
      PENDING_NAMESPACE,
      PENDING_SCOPE,
      requestId,
      pending as unknown as Record<string, unknown>,
    )

    this.emit({
      type: 'memory:space:pull_request',
      spaceId: request.spaceId,
      requestId,
      agentUri: request.from,
    })
  }

  private emit(event: SharedMemoryEvent): void {
    if (this.disposed) return

    // Global handler
    if (this.onEvent) {
      try {
        this.onEvent(event)
      } catch {
        // Non-fatal: event handler failures are swallowed
      }
    }

    // Space-specific subscribers
    const spaceId = event.spaceId
    const subs = this.subscriptions.get(spaceId)
    if (subs) {
      for (const handler of subs) {
        try {
          handler(event)
        } catch {
          // Non-fatal
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function spaceNamespace(spaceId: string): string {
  return `space:${spaceId}`
}

function spaceScope(spaceId: string): Record<string, string> {
  return { _space: spaceId }
}

function keyFromValue(value: Record<string, unknown>, fallbackIndex: number): string {
  if (typeof value['_key'] === 'string') return value['_key']
  if (typeof value['key'] === 'string') return value['key']
  return `record-${fallbackIndex}`
}

function isSpaceRecord(record: Record<string, unknown>): boolean {
  return typeof record['id'] === 'string' && typeof record['name'] === 'string' && typeof record['owner'] === 'string'
}

function toSpace(record: Record<string, unknown>): SharedMemorySpace {
  return record as unknown as SharedMemorySpace
}

function isPendingRecord(record: Record<string, unknown>): boolean {
  return typeof record['id'] === 'string' && record['request'] != null && typeof record['status'] === 'string'
}

function toPending(record: Record<string, unknown>): PendingShareRequest {
  return record as unknown as PendingShareRequest
}

function hasFields(obj: unknown): obj is { fields: Record<string, unknown> } {
  return typeof obj === 'object' && obj !== null && 'fields' in obj && typeof (obj as Record<string, unknown>)['fields'] === 'object'
}

function extractCreatedAt(record: Record<string, unknown>): number {
  // Try provenance timestamp first
  const prov = record['_provenance']
  if (prov != null && typeof prov === 'object') {
    const createdAt = (prov as Record<string, unknown>)['createdAt']
    if (typeof createdAt === 'string') {
      const ts = Date.parse(createdAt)
      if (!Number.isNaN(ts)) return ts
    }
  }
  // Fallback: check top-level createdAt
  if (typeof record['createdAt'] === 'string') {
    const ts = Date.parse(record['createdAt'])
    if (!Number.isNaN(ts)) return ts
  }
  return 0
}
