/**
 * CRDT Network Sync Protocol — Type definitions.
 *
 * Provides the message types, configuration, transport abstraction,
 * and event types for the distributed memory sync protocol.
 */

import type { HLCTimestamp } from '../crdt/types.js'
import type { SharedEntry } from '../shared-namespace.js'

// ---------------------------------------------------------------------------
// Digest & Delta
// ---------------------------------------------------------------------------

/** State digest for efficient comparison (Merkle root hash of all entries). */
export interface SyncDigest {
  /** Node that generated this digest */
  nodeId: string
  /** Merkle tree root hash of all entries (SHA-256 hex) */
  rootHash: string
  /** Number of entries in the namespace */
  entryCount: number
  /** Latest HLC timestamp seen on this node */
  latestTimestamp: HLCTimestamp
  /** Per-key version map for delta detection (key -> version) */
  versionMap: Record<string, number>
}

/** A delta containing only changed entries since a given version. */
export interface SyncDelta {
  /** Node that generated this delta */
  sourceNodeId: string
  /** Changed entries */
  entries: SharedEntry[]
  /** HLC timestamp when the delta was generated */
  generatedAt: HLCTimestamp
}

// ---------------------------------------------------------------------------
// Protocol Messages (discriminated union)
// ---------------------------------------------------------------------------

export interface SyncHelloMessage {
  type: 'sync:hello'
  nodeId: string
  namespaces: string[]
}

export interface SyncDigestMessage {
  type: 'sync:digest'
  digest: SyncDigest
  namespace: string
}

export interface SyncRequestDeltaMessage {
  type: 'sync:request-delta'
  namespace: string
  sinceVersionMap: Record<string, number>
}

export interface SyncDeltaMessage {
  type: 'sync:delta'
  delta: SyncDelta
  namespace: string
}

export interface SyncAckMessage {
  type: 'sync:ack'
  namespace: string
  acceptedCount: number
  rejectedCount: number
}

export interface SyncErrorMessage {
  type: 'sync:error'
  code: string
  message: string
}

export type SyncMessage =
  | SyncHelloMessage
  | SyncDigestMessage
  | SyncRequestDeltaMessage
  | SyncDeltaMessage
  | SyncAckMessage
  | SyncErrorMessage

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

export type SyncSessionState = 'connecting' | 'syncing' | 'idle' | 'error' | 'closed'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SyncConfig {
  /** Unique identifier for this node */
  nodeId: string
  /** Namespaces to sync (undefined = all available) */
  namespaces?: string[]
  /** Anti-entropy interval in ms (default: 30000) */
  antiEntropyIntervalMs?: number
  /** Max entries per delta batch (default: 100) */
  maxBatchSize?: number
}

// ---------------------------------------------------------------------------
// Transport Abstraction
// ---------------------------------------------------------------------------

/** Transport abstraction — anything that can send/receive SyncMessages. */
export interface SyncTransport {
  send(message: SyncMessage): Promise<void>
  onMessage(handler: (message: SyncMessage) => void): void
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Monitoring Events
// ---------------------------------------------------------------------------

export interface SyncConnectedEvent {
  type: 'sync:connected'
  remoteNodeId: string
}

export interface SyncDisconnectedEvent {
  type: 'sync:disconnected'
  remoteNodeId: string
}

export interface SyncDeltaSentEvent {
  type: 'sync:delta-sent'
  namespace: string
  entryCount: number
}

export interface SyncDeltaReceivedEvent {
  type: 'sync:delta-received'
  namespace: string
  accepted: number
  rejected: number
  conflicts: number
}

export interface SyncErrorEvent {
  type: 'sync:error'
  error: string
}

export type SyncEvent =
  | SyncConnectedEvent
  | SyncDisconnectedEvent
  | SyncDeltaSentEvent
  | SyncDeltaReceivedEvent
  | SyncErrorEvent

// ---------------------------------------------------------------------------
// Sync Statistics
// ---------------------------------------------------------------------------

export interface SyncStats {
  sentDeltas: number
  receivedDeltas: number
  conflicts: number
  lastSyncAt: number | null
}
