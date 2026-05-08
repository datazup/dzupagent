/**
 * Data-sharing helpers for {@link MemorySpaceManager}: push / pull-request,
 * query, and pull-request review.
 *
 * Pure orchestration on top of the lower-level `space-share` /
 * `space-pull-request` modules. The coordinator threads in the
 * MemoryService, ProvenanceWriter, and CRDTResolver instances and
 * emits the appropriate events around each call.
 */
import type { MemoryService } from '../memory-service.js'
import type { ProvenanceWriter } from '../provenance/provenance-writer.js'
import type { CRDTResolver } from '../crdt/crdt-resolver.js'
import type {
  MemoryShareRequest,
  PendingShareRequest,
  SharedMemorySpace,
} from './types.js'
import { keyFromValue, spaceNamespace, spaceScope } from './space-helpers.js'
import { handleSharePullRequest, handleSharePush } from './space-share.js'
import { reviewPullRequestForSpace } from './space-pull-request.js'
import { decodePending, isDecoded } from './space-decoders.js'
import {
  PENDING_NAMESPACE,
  PENDING_SCOPE,
} from './memory-space-manager-types.js'

/**
 * Run a `push`-mode share. Returns `hadConflict` so the coordinator
 * can decide whether to emit a conflict event.
 */
export async function performPush(
  deps: {
    memoryService: MemoryService
    provenanceWriter: ProvenanceWriter
    crdtResolver: CRDTResolver
  },
  space: SharedMemorySpace,
  request: MemoryShareRequest,
): Promise<{ hadConflict: boolean }> {
  return handleSharePush({
    memoryService: deps.memoryService,
    provenanceWriter: deps.provenanceWriter,
    crdtResolver: deps.crdtResolver,
    space,
    request,
  })
}

/**
 * Open a pending pull-request. Returns the new request id so the
 * coordinator can include it in the emitted event.
 */
export async function performPullRequest(
  memoryService: MemoryService,
  space: SharedMemorySpace,
  request: MemoryShareRequest,
): Promise<{ requestId: string }> {
  return handleSharePullRequest({
    memoryService,
    space,
    request,
    pendingNamespace: PENDING_NAMESPACE,
    pendingScope: PENDING_SCOPE,
  })
}

/**
 * Query records from a space the agent has access to.
 */
export async function querySpace(
  memoryService: MemoryService,
  space: SharedMemorySpace,
  agentUri: string,
  queryText: string | undefined,
  limit: number,
): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
  const participant = space.participants.find(p => p.agentUri === agentUri)
  if (!participant) {
    throw new Error(`Agent ${agentUri} is not a participant of space ${space.id}`)
  }

  const scope = spaceScope(space.id)

  if (queryText) {
    const results = await memoryService.search(
      spaceNamespace(space.id),
      scope,
      queryText,
      limit,
    )
    return results.map((v, i) => ({ key: keyFromValue(v, i), value: v }))
  }

  const results = await memoryService.get(spaceNamespace(space.id), scope)
  return results.slice(0, limit).map((v, i) => ({ key: keyFromValue(v, i), value: v }))
}

/**
 * Approve or reject a pending pull-request. Result is returned so the
 * coordinator can emit the appropriate event(s).
 */
export async function reviewPullRequest(
  deps: {
    memoryService: MemoryService
    provenanceWriter: ProvenanceWriter
  },
  loadSpace: (spaceId: string) => Promise<SharedMemorySpace | null>,
  requestId: string,
  reviewerUri: string,
  approved: boolean,
): ReturnType<typeof reviewPullRequestForSpace> {
  return reviewPullRequestForSpace({
    memoryService: deps.memoryService,
    provenanceWriter: deps.provenanceWriter,
    loadSpace,
    pendingNamespace: PENDING_NAMESPACE,
    pendingScope: PENDING_SCOPE,
    requestId,
    reviewerUri,
    approved,
  })
}

/** List pending pull-requests for a single space. */
export async function listPendingRequests(
  memoryService: MemoryService,
  spaceId: string,
): Promise<PendingShareRequest[]> {
  const raw = await memoryService.get(PENDING_NAMESPACE, PENDING_SCOPE)
  return raw
    .map(decodePending)
    .filter(isDecoded)
    .filter(p => p.request.spaceId === spaceId && p.status === 'pending')
}
