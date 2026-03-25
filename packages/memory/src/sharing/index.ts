/**
 * Shared memory spaces — barrel exports.
 */
export { MemorySpaceManager } from './memory-space-manager.js'
export type { MemorySpaceManagerConfig } from './memory-space-manager.js'

export type {
  SpacePermission,
  ConflictStrategy,
  ShareMode,
  MemoryParticipant,
  RetentionPolicy,
  SharedMemorySpace,
  MemoryShareRequest,
  PendingShareRequest,
  SharedMemoryEvent,
} from './types.js'
