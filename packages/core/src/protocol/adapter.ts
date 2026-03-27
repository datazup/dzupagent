/**
 * ProtocolAdapter interface — abstracts communication over any protocol.
 *
 * Implementations exist for internal (in-process), A2A, MCP, gRPC, etc.
 * This file defines only the contract; concrete adapters live in separate
 * tickets (ECO-007, ECO-009, etc.).
 */
import type { ForgeMessage, ForgeProtocol } from './message-types.js'

// ---------------------------------------------------------------------------
// Adapter lifecycle
// ---------------------------------------------------------------------------

/** Adapter lifecycle states. */
export type AdapterState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'draining'
  | 'error'

/** Health status reported by adapters. */
export interface AdapterHealthStatus {
  state: AdapterState
  latencyMs?: number
  errorRate?: number
  lastError?: string
  lastConnectedAt?: string
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Options for sending messages. */
export interface SendOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retries?: number
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/** Message handler callback. */
export type MessageHandler = (message: ForgeMessage) => Promise<ForgeMessage | void>

/** Subscription handle returned by `subscribe()`. */
export interface Subscription {
  unsubscribe(): void
}

// ---------------------------------------------------------------------------
// ProtocolAdapter
// ---------------------------------------------------------------------------

/**
 * Protocol adapter interface.
 *
 * Each adapter handles one protocol (internal, a2a, mcp, grpc, etc.)
 * and exposes a uniform send/receive/stream API.
 */
export interface ProtocolAdapter {
  /** The protocol this adapter handles. */
  readonly protocol: ForgeProtocol
  /** Current connection state. */
  readonly state: AdapterState

  /** Establish connection to the remote endpoint. */
  connect(): Promise<void>

  /** Gracefully disconnect. */
  disconnect(): Promise<void>

  /** Send a message and await a single response. */
  send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage>

  /** Send a message and receive a stream of responses. */
  stream(message: ForgeMessage, options?: SendOptions): AsyncIterable<ForgeMessage>

  /** Subscribe to incoming messages matching a URI pattern. */
  subscribe(pattern: string, handler: MessageHandler): Subscription

  /** Get current health status. */
  health(): AdapterHealthStatus
}
