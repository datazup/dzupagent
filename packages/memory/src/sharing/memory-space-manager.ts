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
 * Heavy retention/compaction and CRDT merge logic is delegated to
 * `space-retention.ts` and `space-crdt-push.ts` to keep this file focused
 * on the public API surface and lifecycle bookkeeping.
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
import type {
  SharedMemorySpace,
  SharedMemoryEvent,
  MemoryShareRequest,
  PendingShareRequest,
  SpacePermission,
  ConflictStrategy,
  RetentionPolicy,
  WritableShareMode,
  TombstoneCompactionMetrics,
} from './types.js'
import { keyFromValue, spaceNamespace, spaceScope } from './space-helpers.js'
import {
  compactTombstonesForSpace,
  enforceRetentionForSpace,
} from './space-retention.js'
import { handleSharePullRequest, handleSharePush } from './space-share.js'
import { reviewPullRequestForSpace } from './space-pull-request.js'
import { decodePending, decodeSpace, isDecoded } from './space-decoders.js'

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
  onEvent?: ((event: SharedMemoryEvent) => void) | undefined
  /** Node identifier for the HLC (defaults to a random UUID) */
  nodeId?: string | undefined
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
  private readonly tombstoneCompactionMetrics: TombstoneCompactionMetrics = {
    runs: 0,
    tombstonesFound: 0,
    tombstonesCompacted: 0,
    tombstonesSkipped: 0,
    totalDurationMs: 0,
    lastDurationMs: null,
  }
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
   * - `subscribe`: deprecated; use `MemorySpaceManager.subscribe()` instead
   */
  async share(request: Omit<MemoryShareRequest, 'mode'> & { mode: WritableShareMode }): Promise<void> {
    const space = await this.loadSpace(request.spaceId)
    if (!space) {
      throw new Error(`Space not found: ${request.spaceId}`)
    }

    switch (request.mode) {
      case 'push':
        return this.handlePush(space, request)
      case 'pull-request':
        return this.handlePullRequest(space, request)
      default:
        throw new Error('Subscribe mode is not supported in share(); use MemorySpaceManager.subscribe() instead.')
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
      .map(decodeSpace)
      .filter(isDecoded)

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
    const result = await reviewPullRequestForSpace({
      memoryService: this.memoryService,
      provenanceWriter: this.provenanceWriter,
      loadSpace: spaceId => this.loadSpace(spaceId),
      pendingNamespace: PENDING_NAMESPACE,
      pendingScope: PENDING_SCOPE,
      requestId,
      reviewerUri,
      approved,
    })

    if (result.approved) {
      this.emit({
        type: 'memory:space:write',
        spaceId: result.pending.request.spaceId,
        key: result.pending.request.key,
        agentUri: result.pending.request.from,
      })
    }

    this.emit({
      type: 'memory:space:pull_reviewed',
      spaceId: result.pending.request.spaceId,
      requestId,
      status: result.approved ? 'approved' : 'rejected',
    })
  }

  /**
   * List pending pull requests for a space.
   */
  async listPendingRequests(spaceId: string): Promise<PendingShareRequest[]> {
    const raw = await this.memoryService.get(PENDING_NAMESPACE, PENDING_SCOPE)
    return raw
      .map(decodePending)
      .filter(isDecoded)
      .filter(p => p.request.spaceId === spaceId && p.status === 'pending')
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Enforce retention policy on a space, pruning records that exceed limits.
   *
   * Pruned entries are written back as tombstones. Tombstone compaction is
   * exposed separately via `compactTombstones()` so callers can control when
   * hard deletion happens and observe compaction metrics independently.
   */
  async enforceRetention(spaceId: string): Promise<{ pruned: number }> {
    const space = await this.loadSpace(spaceId)
    if (!space) {
      return { pruned: 0 }
    }
    return enforceRetentionForSpace(this.memoryService, space)
  }

  /**
   * Compact tombstones in a shared space when the backing store supports delete.
   *
   * This reclaims tombstone records after retention pruning and records
   * counters/latency in the manager metrics snapshot.
   */
  async compactTombstones(spaceId: string): Promise<{
    spaceId: string
    tombstonesFound: number
    tombstonesCompacted: number
    tombstonesSkipped: number
    durationMs: number
  }> {
    const startedAt = Date.now()
    const space = await this.loadSpace(spaceId)
    if (!space) {
      return {
        spaceId,
        tombstonesFound: 0,
        tombstonesCompacted: 0,
        tombstonesSkipped: 0,
        durationMs: Date.now() - startedAt,
      }
    }

    const result = await compactTombstonesForSpace(this.memoryService, space, startedAt)

    this.tombstoneCompactionMetrics.runs++
    this.tombstoneCompactionMetrics.tombstonesFound += result.tombstonesFound
    this.tombstoneCompactionMetrics.tombstonesCompacted += result.tombstonesCompacted
    this.tombstoneCompactionMetrics.tombstonesSkipped += result.tombstonesSkipped
    this.tombstoneCompactionMetrics.totalDurationMs += result.durationMs
    this.tombstoneCompactionMetrics.lastDurationMs = result.durationMs

    this.emit({
      type: 'memory:space:tombstones_compacted',
      spaceId,
      tombstonesFound: result.tombstonesFound,
      tombstonesCompacted: result.tombstonesCompacted,
      tombstonesSkipped: result.tombstonesSkipped,
      durationMs: result.durationMs,
    })

    return result
  }

  /** Snapshot tombstone compaction counters/latency metrics. */
  getTombstoneCompactionMetrics(): TombstoneCompactionMetrics {
    return { ...this.tombstoneCompactionMetrics }
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
    if (!record) return null
    return decodeSpace(record)
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
    const { hadConflict } = await handleSharePush({
      memoryService: this.memoryService,
      provenanceWriter: this.provenanceWriter,
      crdtResolver: this.crdtResolver,
      space,
      request,
    })

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
    const { requestId } = await handleSharePullRequest({
      memoryService: this.memoryService,
      space,
      request,
      pendingNamespace: PENDING_NAMESPACE,
      pendingScope: PENDING_SCOPE,
    })

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

