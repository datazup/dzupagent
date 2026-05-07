/**
 * Pull-request review workflow for shared memory spaces.
 *
 * A pull-request is a pending share that requires admin approval before
 * the underlying value is written into the space. The manager owns the
 * surface (`reviewPullRequest`); this module owns the steps:
 *
 *  1. Look up and decode the pending request.
 *  2. Validate that the reviewer has `admin` permission on the target space.
 *  3. Update the pending record's status and reviewer metadata.
 *  4. If approved, perform the deferred write through the provenance writer.
 *
 * The caller is responsible for emitting `memory:space:write` and
 * `memory:space:pull_reviewed` events based on the returned report.
 */

import type { MemoryService } from '../memory-service.js'
import type { ProvenanceWriter } from '../provenance/provenance-writer.js'
import type { PendingShareRequest, SharedMemorySpace } from './types.js'
import { spaceNamespace, spaceScope } from './space-helpers.js'
import { decodePending } from './space-decoders.js'

export interface PullRequestReviewResult {
  pending: PendingShareRequest
  approved: boolean
}

export async function reviewPullRequestForSpace(deps: {
  memoryService: MemoryService
  provenanceWriter: ProvenanceWriter
  loadSpace: (spaceId: string) => Promise<SharedMemorySpace | null>
  pendingNamespace: string
  pendingScope: Record<string, string>
  requestId: string
  reviewerUri: string
  approved: boolean
}): Promise<PullRequestReviewResult> {
  const {
    memoryService,
    provenanceWriter,
    loadSpace,
    pendingNamespace,
    pendingScope,
    requestId,
    reviewerUri,
    approved,
  } = deps

  const raw = await memoryService.get(pendingNamespace, pendingScope, requestId)
  if (raw.length === 0) {
    throw new Error(`Pending request not found: ${requestId}`)
  }
  const record = raw[0]
  const pending = record ? decodePending(record) : null
  if (!pending) {
    throw new Error(`Pending request not found: ${requestId}`)
  }

  const space = await loadSpace(pending.request.spaceId)
  if (!space) {
    throw new Error(`Space not found: ${pending.request.spaceId}`)
  }

  const reviewer = space.participants.find(p => p.agentUri === reviewerUri)
  if (!reviewer || reviewer.permission !== 'admin') {
    throw new Error(
      `Agent ${reviewerUri} does not have admin permission on space ${pending.request.spaceId}`,
    )
  }

  const now = new Date().toISOString()
  const updated: PendingShareRequest = {
    ...pending,
    status: approved ? 'approved' : 'rejected',
    reviewedBy: reviewerUri,
    reviewedAt: now,
  }

  await memoryService.put(
    pendingNamespace,
    pendingScope,
    requestId,
    updated as unknown as Record<string, unknown>,
  )

  if (approved) {
    const scope = spaceScope(pending.request.spaceId)
    await provenanceWriter.put(
      spaceNamespace(pending.request.spaceId),
      scope,
      pending.request.key,
      pending.request.value,
      { agentUri: pending.request.from, source: 'shared' },
    )
  }

  return { pending, approved }
}
