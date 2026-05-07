/**
 * Decoders for shared-space records read from the underlying memory store.
 *
 * Records arrive as `Record<string, unknown>` because the store contract
 * is intentionally schema-agnostic. These functions validate shape and
 * return strongly-typed values, returning `null` for malformed input so
 * callers can choose to skip rather than throw.
 */

import type {
  ConflictStrategy,
  MemoryShareRequest,
  PendingShareRequest,
  RetentionPolicy,
  SharedMemorySpace,
  SpacePermission,
} from './types.js'

export function decodeSpace(record: Record<string, unknown>): SharedMemorySpace | null {
  const id = record['id']
  const name = record['name']
  const owner = record['owner']
  const participantsValue = record['participants']
  const conflictResolution = record['conflictResolution']
  const createdAt = record['createdAt']

  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof owner !== 'string' ||
    !Array.isArray(participantsValue) ||
    !isConflictStrategy(conflictResolution) ||
    !isIsoTimestamp(createdAt)
  ) {
    return null
  }

  const participants: SharedMemorySpace['participants'] = []
  for (const participantValue of participantsValue) {
    const participant = decodeParticipant(participantValue)
    if (!participant) return null
    participants.push(participant)
  }

  const space: SharedMemorySpace = {
    id,
    name,
    owner,
    participants,
    conflictResolution,
    createdAt,
  }

  if ('retentionPolicy' in record) {
    const retentionPolicy = decodeRetentionPolicy(record['retentionPolicy'])
    if (!retentionPolicy) return null
    space.retentionPolicy = retentionPolicy
  }

  return space
}

export function decodePending(record: Record<string, unknown>): PendingShareRequest | null {
  const id = record['id']
  const request = decodeShareRequest(record['request'])
  const status = record['status']
  const createdAt = record['createdAt']

  if (
    typeof id !== 'string' ||
    !request ||
    !isShareRequestStatus(status) ||
    !isIsoTimestamp(createdAt)
  ) {
    return null
  }

  const pending: PendingShareRequest = {
    id,
    request,
    status,
    createdAt,
  }

  if ('reviewedBy' in record) {
    const reviewedBy = record['reviewedBy']
    if (typeof reviewedBy !== 'string') return null
    pending.reviewedBy = reviewedBy
  }
  if ('reviewedAt' in record) {
    const reviewedAt = record['reviewedAt']
    if (!isIsoTimestamp(reviewedAt)) return null
    pending.reviewedAt = reviewedAt
  }

  return pending
}

export function isDecoded<T>(value: T | null): value is T {
  return value !== null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function decodeParticipant(value: unknown): SharedMemorySpace['participants'][number] | null {
  if (!isRecord(value)) return null
  const agentUri = value['agentUri']
  const permission = value['permission']
  const joinedAt = value['joinedAt']

  if (typeof agentUri !== 'string' || !isSpacePermission(permission) || !isIsoTimestamp(joinedAt)) {
    return null
  }

  return { agentUri, permission, joinedAt }
}

function decodeRetentionPolicy(value: unknown): RetentionPolicy | null {
  if (!isRecord(value)) return null

  const policy: RetentionPolicy = {}
  if ('maxAgeMs' in value) {
    const maxAgeMs = value['maxAgeMs']
    if (!isNonNegativeFiniteNumber(maxAgeMs)) return null
    policy.maxAgeMs = maxAgeMs
  }
  if ('maxRecords' in value) {
    const maxRecords = value['maxRecords']
    if (typeof maxRecords !== 'number' || !Number.isSafeInteger(maxRecords) || maxRecords < 0) return null
    policy.maxRecords = maxRecords
  }

  return policy
}

function decodeShareRequest(value: unknown): MemoryShareRequest | null {
  if (!isRecord(value)) return null

  const from = value['from']
  const spaceId = value['spaceId']
  const key = value['key']
  const requestValue = value['value']
  const mode = value['mode']

  if (
    typeof from !== 'string' ||
    typeof spaceId !== 'string' ||
    typeof key !== 'string' ||
    !isRecord(requestValue) ||
    !isShareMode(mode)
  ) {
    return null
  }

  return {
    from,
    spaceId,
    key,
    value: requestValue,
    mode,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSpacePermission(value: unknown): value is SpacePermission {
  return value === 'read' || value === 'read-write' || value === 'admin'
}

function isConflictStrategy(value: unknown): value is ConflictStrategy {
  return value === 'lww' || value === 'manual' || value === 'crdt'
}

function isShareMode(value: unknown): value is MemoryShareRequest['mode'] {
  return value === 'push' || value === 'pull-request' || value === 'subscribe'
}

function isShareRequestStatus(value: unknown): value is PendingShareRequest['status'] {
  return value === 'pending' || value === 'approved' || value === 'rejected'
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
