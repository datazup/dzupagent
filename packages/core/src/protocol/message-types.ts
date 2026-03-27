/**
 * ForgeMessage envelope types.
 *
 * Defines the core message primitives used for inter-agent communication
 * across all supported protocols (internal, A2A, MCP, gRPC, ANP, etc.).
 */
import type { ForgeErrorCode } from '../errors/error-codes.js'

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/** Unique message identifier (UUIDv7-style). */
export type ForgeMessageId = string & { readonly __brand: 'ForgeMessageId' }

// ---------------------------------------------------------------------------
// Discriminators
// ---------------------------------------------------------------------------

/** Message type discriminator. */
export type ForgeMessageType =
  | 'request'
  | 'response'
  | 'notification'
  | 'stream_chunk'
  | 'stream_end'
  | 'error'

/**
 * Protocol discriminator — extensible union.
 *
 * Known values get autocomplete; arbitrary strings are also accepted
 * via the `(string & {})` widening trick.
 */
export type ForgeProtocol =
  | 'internal'
  | 'a2a'
  | 'mcp'
  | 'grpc'
  | 'anp'
  | 'http'
  | 'ws'
  | (string & {})

/** Priority levels for message routing. */
export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent'

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Budget constraints carried in message metadata. */
export interface MessageBudget {
  maxTokens?: number
  maxCostCents?: number
  maxDurationMs?: number
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Metadata attached to every message. */
export interface ForgeMessageMetadata {
  traceId?: string
  spanId?: string
  priority?: MessagePriority
  ttlMs?: number
  /**
   * Token ID for delegation chain lookup.
   * For A2A cross-process messages, the full DelegationToken object
   * is serialized separately in the message payload.
   */
  delegationTokenId?: string
  budget?: MessageBudget
  /** Custom extension metadata. */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Discriminated union of all payload variants. */
export type ForgePayload =
  | { type: 'text'; content: string }
  | { type: 'json'; data: Record<string, unknown> }
  | { type: 'tool_call'; toolName: string; arguments: Record<string, unknown>; callId: string }
  | { type: 'tool_result'; callId: string; result: unknown; isError?: boolean }
  | { type: 'task'; taskId: string; description: string; context?: Record<string, unknown> }
  | { type: 'binary'; mimeType: string; data: Uint8Array; description?: string }
  | { type: 'error'; code: ForgeErrorCode; message: string; details?: Record<string, unknown> }

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

/** The core message envelope for all inter-agent communication. */
export interface ForgeMessage {
  /** Unique message identifier. */
  id: ForgeMessageId
  /** Message type discriminator. */
  type: ForgeMessageType
  /** URI of sender (forge://, a2a://, mcp://, etc.). */
  from: string
  /** URI of recipient. */
  to: string
  /** Protocol used for transport. */
  protocol: ForgeProtocol
  /** ISO 8601 timestamp. */
  timestamp: string
  /** Links request/response pairs. */
  correlationId?: string
  /** For threading — references a parent message. */
  parentId?: ForgeMessageId
  /** The message content. */
  payload: ForgePayload
  /** Extensible metadata. */
  metadata: ForgeMessageMetadata
}
