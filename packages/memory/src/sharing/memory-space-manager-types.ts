/**
 * Shared constants and configuration types for {@link MemorySpaceManager}.
 *
 * Lives in its own module so the lifecycle / sharing / retention helpers
 * can import it without depending on each other or the coordinator.
 */
import type { MemoryService } from '../memory-service.js'
import type { SharedMemoryEvent } from './types.js'

export const SPACES_NAMESPACE = '__spaces'
export const PENDING_NAMESPACE = '__pending_shares'
export const SPACE_SCOPE: Record<string, string> = { _ns: SPACES_NAMESPACE }
export const PENDING_SCOPE: Record<string, string> = { _ns: PENDING_NAMESPACE }

export interface MemorySpaceManagerConfig {
  memoryService: MemoryService
  /** Optional event handler for shared memory events */
  onEvent?: ((event: SharedMemoryEvent) => void) | undefined
  /** Node identifier for the HLC (defaults to a random UUID) */
  nodeId?: string | undefined
}
