/**
 * Share-mode handlers for shared memory spaces (push + pull-request creation).
 *
 * The manager owns the public `share()` surface and routes by mode; this
 * module owns the per-mode workflow:
 *
 *  - `handleSharePush`:  participant + permission check, then either a CRDT
 *    merge or a direct provenance write. Returns metadata so the caller can
 *    emit `memory:space:write` (and `memory:space:conflict` on CRDT merge).
 *  - `handleSharePullRequest`: participant check, then enqueues a pending
 *    request and returns the new request id for the caller to emit.
 */

import { randomUUID } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import type { ProvenanceWriter } from '../provenance/provenance-writer.js'
import type { CRDTResolver } from '../crdt/crdt-resolver.js'
import type { MemoryShareRequest, PendingShareRequest, SharedMemorySpace } from './types.js'
import { spaceNamespace, spaceScope } from './space-helpers.js'
import { handleCRDTPushForSpace } from './space-crdt-push.js'

export interface SharePushResult {
  hadConflict: boolean
}

export async function handleSharePush(deps: {
  memoryService: MemoryService
  provenanceWriter: ProvenanceWriter
  crdtResolver: CRDTResolver
  space: SharedMemorySpace
  request: MemoryShareRequest
}): Promise<SharePushResult> {
  const { memoryService, provenanceWriter, crdtResolver, space, request } = deps

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
    const result = await handleCRDTPushForSpace({
      memoryService,
      provenanceWriter,
      crdtResolver,
      space,
      request,
      ns,
      scope,
    })
    return { hadConflict: result.hadConflict }
  }

  await provenanceWriter.put(
    ns,
    scope,
    request.key,
    request.value,
    { agentUri: request.from, source: 'shared' },
  )
  return { hadConflict: false }
}

export async function handleSharePullRequest(deps: {
  memoryService: MemoryService
  space: SharedMemorySpace
  request: MemoryShareRequest
  pendingNamespace: string
  pendingScope: Record<string, string>
}): Promise<{ requestId: string }> {
  const { memoryService, space, request, pendingNamespace, pendingScope } = deps

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

  await memoryService.put(
    pendingNamespace,
    pendingScope,
    requestId,
    pending as unknown as Record<string, unknown>,
  )

  return { requestId }
}
