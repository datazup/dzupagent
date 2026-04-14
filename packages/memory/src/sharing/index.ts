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
  WritableShareMode,
  SharedMemorySpace,
  MemoryShareRequest,
  PendingShareRequest,
  TombstoneCompactionMetrics,
  SharedMemoryEvent,
} from './types.js'
