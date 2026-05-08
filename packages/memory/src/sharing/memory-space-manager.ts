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
 * This file is the coordinator. It owns class state (subscriptions,
 * tombstone metrics, the HLC-backed CRDT resolver, the disposed flag)
 * and delegates the actual work to focused sibling modules:
 *
 *   - `memory-space-manager-types`      constants + config
 *   - `memory-space-manager-lifecycle`  create / join / leave / load / list
 *   - `memory-space-manager-sharing`    push / pull-request / query / review
 *   - `memory-space-manager-retention`  retention enforce + tombstone compact
 *
 * Heavy retention/compaction and CRDT merge logic continues to live in
 * `space-retention.ts` and `space-crdt-push.ts`.
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
  WritableShareMode,
  TombstoneCompactionMetrics,
} from './types.js'
import {
  type MemorySpaceManagerConfig,
} from './memory-space-manager-types.js'
import {
  createSpace,
  joinSpace,
  leaveSpace,
  listSpaces,
  loadSpace,
} from './memory-space-manager-lifecycle.js'
import {
  listPendingRequests,
  performPullRequest,
  performPush,
  querySpace,
  reviewPullRequest,
} from './memory-space-manager-sharing.js'
import {
  compactTombstones,
  emptyTombstoneCompactionMetrics,
  enforceRetention,
  type CompactionResult,
} from './memory-space-manager-retention.js'

// Re-export the public config type so existing callers can keep importing
// from `./memory-space-manager.js` unchanged.
export type { MemorySpaceManagerConfig } from './memory-space-manager-types.js'

export class MemorySpaceManager {
  private readonly memoryService: MemoryService
  private readonly provenanceWriter: ProvenanceWriter
  private readonly onEvent: ((event: SharedMemoryEvent) => void) | undefined
  private readonly subscriptions: Map<string, Set<(event: SharedMemoryEvent) => void>> = new Map()
  private readonly crdtResolver: CRDTResolver
  private readonly tombstoneCompactionMetrics: TombstoneCompactionMetrics =
    emptyTombstoneCompactionMetrics()
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
  async create(params: Parameters<typeof createSpace>[1]): Promise<SharedMemorySpace> {
    const space = await createSpace(this.memoryService, params)
    this.emit({ type: 'memory:space:created', spaceId: space.id, owner: params.owner })
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
    const space = await loadSpace(this.memoryService, spaceId)
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`)
    }

    const added = await joinSpace(this.memoryService, space, agentUri, permission)
    if (added) {
      this.emit({ type: 'memory:space:joined', spaceId, agentUri, permission })
    }
  }

  /**
   * Leave a shared memory space.
   */
  async leave(spaceId: string, agentUri: string): Promise<void> {
    const space = await loadSpace(this.memoryService, spaceId)
    if (!space) return

    const removed = await leaveSpace(this.memoryService, space, agentUri)
    if (removed) {
      this.emit({ type: 'memory:space:left', spaceId, agentUri })
    }
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
  async share(
    request: Omit<MemoryShareRequest, 'mode'> & { mode: WritableShareMode },
  ): Promise<void> {
    const space = await loadSpace(this.memoryService, request.spaceId)
    if (!space) {
      throw new Error(`Space not found: ${request.spaceId}`)
    }

    switch (request.mode) {
      case 'push':
        return this.handlePush(space, request)
      case 'pull-request':
        return this.handlePullRequest(space, request)
      default:
        throw new Error(
          'Subscribe mode is not supported in share(); use MemorySpaceManager.subscribe() instead.',
        )
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
    const space = await loadSpace(this.memoryService, spaceId)
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`)
    }
    return querySpace(this.memoryService, space, agentUri, queryText, limit)
  }

  // -------------------------------------------------------------------------
  // Space queries
  // -------------------------------------------------------------------------

  /**
   * Get space metadata by ID.
   */
  async getSpace(spaceId: string): Promise<SharedMemorySpace | undefined> {
    const space = await loadSpace(this.memoryService, spaceId)
    return space ?? undefined
  }

  /**
   * List all spaces, optionally filtered to those a specific agent participates in.
   */
  async listSpaces(agentUri?: string): Promise<SharedMemorySpace[]> {
    return listSpaces(this.memoryService, agentUri)
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
    const result = await reviewPullRequest(
      { memoryService: this.memoryService, provenanceWriter: this.provenanceWriter },
      spaceId => loadSpace(this.memoryService, spaceId),
      requestId,
      reviewerUri,
      approved,
    )

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
    return listPendingRequests(this.memoryService, spaceId)
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
    const space = await loadSpace(this.memoryService, spaceId)
    return enforceRetention(this.memoryService, space)
  }

  /**
   * Compact tombstones in a shared space when the backing store supports delete.
   *
   * This reclaims tombstone records after retention pruning and records
   * counters/latency in the manager metrics snapshot.
   */
  async compactTombstones(spaceId: string): Promise<CompactionResult> {
    const startedAt = Date.now()
    const space = await loadSpace(this.memoryService, spaceId)
    const result = await compactTombstones(
      this.memoryService,
      this.tombstoneCompactionMetrics,
      space,
      spaceId,
      startedAt,
    )

    if (space) {
      this.emit({
        type: 'memory:space:tombstones_compacted',
        spaceId,
        tombstonesFound: result.tombstonesFound,
        tombstonesCompacted: result.tombstonesCompacted,
        tombstonesSkipped: result.tombstonesSkipped,
        durationMs: result.durationMs,
      })
    }

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

  private async handlePush(
    space: SharedMemorySpace,
    request: MemoryShareRequest,
  ): Promise<void> {
    const { hadConflict } = await performPush(
      {
        memoryService: this.memoryService,
        provenanceWriter: this.provenanceWriter,
        crdtResolver: this.crdtResolver,
      },
      space,
      request,
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

  private async handlePullRequest(
    space: SharedMemorySpace,
    request: MemoryShareRequest,
  ): Promise<void> {
    const { requestId } = await performPullRequest(this.memoryService, space, request)
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
