/**
 * Space lifecycle helpers for {@link MemorySpaceManager}.
 *
 * Pure functions that own create / join / leave / load / save bookkeeping
 * for shared memory spaces. The coordinator threads its `MemoryService`
 * handle and calls these to mutate space state, then emits the
 * appropriate event(s).
 */
import { randomUUID } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import type {
  ConflictStrategy,
  RetentionPolicy,
  SharedMemorySpace,
  SpacePermission,
} from './types.js'
import { decodeSpace, isDecoded } from './space-decoders.js'
import { SPACES_NAMESPACE, SPACE_SCOPE } from './memory-space-manager-types.js'

/**
 * Construct + persist a new space record, returning the canonical shape.
 */
export async function createSpace(
  memoryService: MemoryService,
  params: {
    name: string
    owner: string
    conflictResolution?: ConflictStrategy
    retentionPolicy?: RetentionPolicy
  },
): Promise<SharedMemorySpace> {
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

  await memoryService.put(
    SPACES_NAMESPACE,
    SPACE_SCOPE,
    id,
    space as unknown as Record<string, unknown>,
  )

  return space
}

/**
 * Add an agent to an existing space if not already a participant.
 *
 * Returns `true` when the participant was added, `false` when the agent
 * was already in the space.
 */
export async function joinSpace(
  memoryService: MemoryService,
  space: SharedMemorySpace,
  agentUri: string,
  permission: SpacePermission,
): Promise<boolean> {
  const existing = space.participants.find(p => p.agentUri === agentUri)
  if (existing) return false

  space.participants.push({
    agentUri,
    permission,
    joinedAt: new Date().toISOString(),
  })

  await saveSpace(memoryService, space)
  return true
}

/**
 * Remove an agent from a space if they are a participant. No-op otherwise.
 *
 * Returns `true` when the participant was removed.
 */
export async function leaveSpace(
  memoryService: MemoryService,
  space: SharedMemorySpace,
  agentUri: string,
): Promise<boolean> {
  const idx = space.participants.findIndex(p => p.agentUri === agentUri)
  if (idx === -1) return false

  space.participants.splice(idx, 1)
  await saveSpace(memoryService, space)
  return true
}

/** Load a single space by id, returning null when not found. */
export async function loadSpace(
  memoryService: MemoryService,
  spaceId: string,
): Promise<SharedMemorySpace | null> {
  const raw = await memoryService.get(SPACES_NAMESPACE, SPACE_SCOPE, spaceId)
  if (raw.length === 0) return null
  const record = raw[0]
  if (!record) return null
  return decodeSpace(record)
}

/** Persist an updated space record. */
export async function saveSpace(
  memoryService: MemoryService,
  space: SharedMemorySpace,
): Promise<void> {
  await memoryService.put(
    SPACES_NAMESPACE,
    SPACE_SCOPE,
    space.id,
    space as unknown as Record<string, unknown>,
  )
}

/**
 * List all spaces, optionally filtered to those `agentUri` participates in.
 */
export async function listSpaces(
  memoryService: MemoryService,
  agentUri?: string,
): Promise<SharedMemorySpace[]> {
  const raw = await memoryService.get(SPACES_NAMESPACE, SPACE_SCOPE)
  const spaces = raw.map(decodeSpace).filter(isDecoded)

  if (!agentUri) return spaces
  return spaces.filter(s => s.participants.some(p => p.agentUri === agentUri))
}
