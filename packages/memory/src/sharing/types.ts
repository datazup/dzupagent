/**
 * Shared memory space types.
 *
 * Defines the data structures for multi-agent memory sharing:
 * spaces, participants, permissions, conflict strategies, and events.
 */

/** Permission level for a participant in a shared memory space. */
export type SpacePermission = 'read' | 'read-write' | 'admin'

/** Strategy for resolving write conflicts within a shared space. */
export type ConflictStrategy = 'lww' | 'manual' | 'crdt'

/** Mode used when sharing data into a space. */
export type ShareMode = 'push' | 'pull-request' | 'subscribe'

/**
 * Share modes accepted by `MemorySpaceManager.share()`.
 *
 * `subscribe` remains in the public type for compatibility, but the runtime
 * API now routes consumers to `MemorySpaceManager.subscribe()` instead.
 */
export type WritableShareMode = Exclude<ShareMode, 'subscribe'>

/** An agent participating in a shared memory space. */
export interface MemoryParticipant {
  /** Agent URI in forge://org/agent-name format */
  agentUri: string
  /** Access level within the space */
  permission: SpacePermission
  /** ISO-8601 timestamp when the agent joined */
  joinedAt: string
}

/** Retention policy for records within a shared space. */
export interface RetentionPolicy {
  /** Maximum age of records in milliseconds */
  maxAgeMs?: number | undefined
  /** Maximum number of records in the space */
  maxRecords?: number | undefined
}

/** Metadata describing a shared memory space. */
export interface SharedMemorySpace {
  /** Unique identifier for the space */
  id: string
  /** Human-readable name */
  name: string
  /** forge:// URI of the space creator */
  owner: string
  /** List of participating agents */
  participants: MemoryParticipant[]
  /** Optional retention rules */
  retentionPolicy?: RetentionPolicy | undefined
  /** How write conflicts are resolved */
  conflictResolution: ConflictStrategy
  /** ISO-8601 creation timestamp */
  createdAt: string
}

/** Request to share data into a space. */
export interface MemoryShareRequest {
  /** Agent URI performing the share */
  from: string
  /** Target space ID */
  spaceId: string
  /** Record key */
  key: string
  /** Record value */
  value: Record<string, unknown>
  /** Sharing mode */
  mode: ShareMode
}

/** A pending pull-request style share awaiting review. */
export interface PendingShareRequest {
  /** Unique request ID */
  id: string
  /** The original share request */
  request: MemoryShareRequest
  /** Current review status */
  status: 'pending' | 'approved' | 'rejected'
  /** ISO-8601 creation timestamp */
  createdAt: string
  /** URI of the reviewer (if reviewed) */
  reviewedBy?: string | undefined
  /** ISO-8601 review timestamp (if reviewed) */
  reviewedAt?: string | undefined
}

/** Metrics emitted by tombstone compaction. */
export interface TombstoneCompactionMetrics {
  runs: number
  tombstonesFound: number
  tombstonesCompacted: number
  tombstonesSkipped: number
  totalDurationMs: number
  lastDurationMs: number | null
}

/** Discriminated union of events emitted by the shared memory system. */
export type SharedMemoryEvent =
  | { type: 'memory:space:created'; spaceId: string; owner: string }
  | { type: 'memory:space:joined'; spaceId: string; agentUri: string; permission: SpacePermission }
  | { type: 'memory:space:left'; spaceId: string; agentUri: string }
  | { type: 'memory:space:write'; spaceId: string; key: string; agentUri: string }
  | { type: 'memory:space:pull_request'; spaceId: string; requestId: string; agentUri: string }
  | { type: 'memory:space:pull_reviewed'; spaceId: string; requestId: string; status: 'approved' | 'rejected' }
  | { type: 'memory:space:conflict'; spaceId: string; key: string; agentUri: string }
  | {
      type: 'memory:space:tombstones_compacted'
      spaceId: string
      tombstonesFound: number
      tombstonesCompacted: number
      tombstonesSkipped: number
      durationMs: number
    }
