/**
 * CRDT Network Sync Protocol — barrel exports.
 */

// --- Types ---
export type {
  SyncDigest,
  SyncDelta,
  SyncMessage,
  SyncHelloMessage,
  SyncDigestMessage,
  SyncRequestDeltaMessage,
  SyncDeltaMessage,
  SyncAckMessage,
  SyncErrorMessage,
  SyncSessionState,
  SyncConfig,
  SyncTransport,
  SyncEvent,
  SyncConnectedEvent,
  SyncDisconnectedEvent,
  SyncDeltaSentEvent,
  SyncDeltaReceivedEvent,
  SyncErrorEvent,
  SyncStats,
} from './types.js'

// --- Merkle Digest ---
export { MerkleDigest } from './merkle-digest.js'

// --- Sync Protocol ---
export { SyncProtocol } from './sync-protocol.js'

// --- Sync Session ---
export { SyncSession } from './sync-session.js'

// --- WebSocket Transport ---
export { WebSocketSyncTransport } from './ws-transport.js'
export type { WebSocketLike } from './ws-transport.js'
