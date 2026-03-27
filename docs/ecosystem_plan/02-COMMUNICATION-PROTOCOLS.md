# 02 — Communication Protocols

> **Created:** 2026-03-24
> **Status:** Planning
> **Dependencies:** 01-IDENTITY-TRUST (ForgeIdentity, delegation tokens, URI scheme)
> **Packages affected:** `@dzipagent/core`, `@dzipagent/a2a` (new), `@dzipagent/server`
> **Total estimated effort:** ~72h across 10 features (F1-F10)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - [F1: ForgeMessage Envelope](#f1-forgemessage-envelope-p0-4h)
   - [F2: ProtocolAdapter Interface](#f2-protocoladapter-interface-p0-4h)
   - [F3: InternalAdapter](#f3-internaladapter-p0-included-in-f2)
   - [F4: A2A Client Adapter](#f4-a2a-client-adapter-p0-12h)
   - [F5: MCP Resources Support](#f5-mcp-resources-support-p1-8h)
   - [F6: MCP Sampling Support](#f6-mcp-sampling-support-p1-8h)
   - [F7: Protocol Bridge](#f7-protocol-bridge-p1-8h)
   - [F8: Message Serialization](#f8-message-serialization-p1-4h)
   - [F9: gRPC Transport](#f9-grpc-transport-p2-12h)
   - [F10: Protocol Negotiation](#f10-protocol-negotiation-p2-8h)
3. [Data Flow Diagrams](#3-data-flow-diagrams)
4. [File Structure](#4-file-structure)
5. [Integration Points](#5-integration-points)
6. [Testing Strategy](#6-testing-strategy)
7. [Migration Path](#7-migration-from-current-state)

---

## 1. Architecture Overview

### 1.1 Current State

DzipAgent currently has three separate, uncoordinated communication mechanisms:

| Mechanism | Location | Transport | Scope |
|-----------|----------|-----------|-------|
| **DzipEventBus** | `core/src/events/event-bus.ts` | In-process pub-sub | Typed discriminated union (~25 event types), fire-and-forget, wildcard support |
| **AgentBus** | `core/src/events/agent-bus.ts` | In-process named channels | Agent-to-agent messages with circular buffer history (100 entries) |
| **MCPClient/Server** | `core/src/mcp/` | HTTP, SSE, stdio | JSON-RPC 2.0, tool discovery with eager/deferred loading |
| **A2A routes** | `server/src/a2a/` + `server/src/routes/a2a.ts` | Hono HTTP REST | Task submit/poll/cancel, agent card at `/.well-known/agent.json` |

Problems with the current state:

1. **No unified message format** -- AgentBus uses `AgentMessage` (bare payload), A2A uses raw JSON bodies, MCP uses JSON-RPC. No correlation across protocols.
2. **No abstract adapter layer** -- Each protocol is accessed through a different API. Switching from in-process to A2A requires rewriting call sites.
3. **No streaming on A2A** -- The current A2A routes only support poll-based task status. No SSE streaming for real-time updates.
4. **MCP is tools-only** -- No support for MCP Resources (read/subscribe) or Sampling (server-initiated LLM requests).
5. **No protocol bridging** -- Cannot expose an MCP tool as an A2A capability or vice versa.

### 1.2 Target Architecture

```
                         DzipAgent Process
  +------------------------------------------------------------------+
  |                                                                    |
  |   DzipAgent.generate()                                           |
  |        |                                                           |
  |        v                                                           |
  |   ProtocolRouter                                                   |
  |        |                                                           |
  |        +--- resolves target agent URI (forge://local/...,          |
  |        |    forge://remote/..., a2a://..., mcp://...)              |
  |        |                                                           |
  |        v                                                           |
  |   ProtocolAdapter (abstract interface)                             |
  |        |                                                           |
  |   +----+----+----------+-----------+-----------+                   |
  |   |         |          |           |           |                   |
  |   v         v          v           v           v                   |
  | Internal  A2AClient  MCPClient   gRPC     (future:               |
  | Adapter   Adapter    Adapter*    Adapter    ANP)                  |
  |   |         |          |           |                               |
  |   v         v          v           v                               |
  | EventBus  HTTP/SSE  JSON-RPC   Proto/H2                           |
  |            (A2A)    (MCP)                                          |
  |                                                                    |
  +------------------------------------------------------------------+

  * MCPClient Adapter wraps existing MCPClient, does NOT replace it.
    MCPClient remains the low-level transport; the adapter adds
    ForgeMessage envelope translation on top.

  All adapters produce and consume ForgeMessage envelopes.
  Serialization is pluggable (JSON default, MessagePack optional).
```

### 1.3 Relationship Between Internal Events, MCP, and A2A

```
  DzipEventBus (internal, typed, fire-and-forget)
       |
       |  DzipEvent discriminated union (~25 types)
       |  Used for: lifecycle events, budget warnings,
       |            plugin hooks, observability
       |
       +---> EventBridge (server/ws) ---> WebSocket clients
       |
       +---> InternalAdapter ---> ForgeMessage envelope
                |                     |
                |   same envelope     |
                |   format used by    |
                |                     |
                +-----> A2AClientAdapter ---> remote A2A agents
                |
                +-----> MCPClientAdapter ---> MCP servers
                |
                +-----> gRPCAdapter (P2)  ---> gRPC peers

  Key insight: DzipEventBus stays as the internal nervous system.
  ProtocolAdapter is the EXTERNAL communication layer. They are
  connected via InternalAdapter which wraps DzipEventBus messages
  into ForgeMessage envelopes when crossing process boundaries.
```

### 1.4 Design Principles

1. **ForgeMessage is the universal envelope** -- every cross-boundary message (including in-process agent-to-agent) is wrapped in a ForgeMessage. Internal DzipEvents are NOT ForgeMessages; they remain lightweight fire-and-forget signals.
2. **Adapters are stateful connections** -- they manage transport lifecycle (connect/disconnect/reconnect) and expose a uniform send/stream/subscribe API.
3. **Protocol selection is URI-based** -- `forge://local/agent-id` routes to InternalAdapter; `a2a://host:port/agent-name` routes to A2AClientAdapter; `mcp://server-id/tool-name` routes to MCPClientAdapter.
4. **Non-fatal everywhere** -- adapter failures produce ForgeError with `recoverable: true` and emit events on DzipEventBus. They never crash the agent loop.
5. **Budget propagation** -- ForgeMessage metadata carries budget allocation so remote agents can respect the caller's constraints.

---

## 2. Feature Specifications

### F1: ForgeMessage Envelope (P0, 4h)

> **Owner:** `@dzipagent/core` (`core/src/protocol/message.ts`)
> **Depends on:** 01-IDENTITY-TRUST for `ForgeIdentity` type

The ForgeMessage is the canonical envelope for ALL inter-agent and agent-to-tool communication. It is protocol-agnostic -- the same structure is used whether the transport is in-process, HTTP (A2A), JSON-RPC (MCP), or gRPC.

#### 2.1.1 Core Types

```typescript
// core/src/protocol/message.ts

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Message ID
// ---------------------------------------------------------------------------

/** Globally unique message identifier. UUIDv7 for time-ordering. */
export type ForgeMessageId = string & { readonly __brand: 'ForgeMessageId' };

export function createMessageId(): ForgeMessageId {
  // UUIDv7 provides time-ordered uniqueness
  return crypto.randomUUID() as ForgeMessageId;
}

// ---------------------------------------------------------------------------
// Message Types (discriminator)
// ---------------------------------------------------------------------------

/**
 * Discriminator for ForgeMessage.type field.
 *
 * - request: expects a response (correlationId links them)
 * - response: answers a prior request
 * - notification: fire-and-forget, no response expected
 * - stream_chunk: partial result in a streaming response
 * - stream_end: terminal frame for a streaming response
 * - error: structured error response
 */
export type ForgeMessageType =
  | 'request'
  | 'response'
  | 'notification'
  | 'stream_chunk'
  | 'stream_end'
  | 'error';

// ---------------------------------------------------------------------------
// Protocol Origin
// ---------------------------------------------------------------------------

/**
 * Which protocol produced or will consume this message.
 * Used by ProtocolRouter to select the correct adapter.
 */
export type ForgeProtocol =
  | 'internal'   // In-process via DzipEventBus/AgentBus
  | 'a2a'        // Google A2A protocol (JSON-RPC / REST)
  | 'mcp'        // Model Context Protocol (JSON-RPC 2.0)
  | 'grpc'       // gRPC (future)
  | 'anp'        // Agent Network Protocol (future)
  | 'http';      // Raw HTTP (webhooks, REST connectors)

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * ForgePayload uses a contentType discriminator so consumers
 * can switch on the shape without inspecting raw data.
 */
export type ForgePayload =
  | ForgeTextPayload
  | ForgeJsonPayload
  | ForgeToolCallPayload
  | ForgeToolResultPayload
  | ForgeTaskPayload
  | ForgeBinaryPayload
  | ForgeErrorPayload;

export interface ForgeTextPayload {
  contentType: 'text';
  text: string;
}

export interface ForgeJsonPayload {
  contentType: 'json';
  /** Arbitrary structured data. Must be JSON-serializable. */
  data: Record<string, unknown>;
  /** Optional JSON Schema URI for validation. */
  schema?: string;
}

export interface ForgeToolCallPayload {
  contentType: 'tool_call';
  toolName: string;
  arguments: Record<string, unknown>;
  /** MCP server ID when the tool originates from MCP. */
  serverId?: string;
}

export interface ForgeToolResultPayload {
  contentType: 'tool_result';
  toolName: string;
  result: string;
  isError: boolean;
  durationMs?: number;
}

export interface ForgeTaskPayload {
  contentType: 'task';
  /** A2A task lifecycle fields */
  taskId: string;
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'cancelled';
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface ForgeBinaryPayload {
  contentType: 'binary';
  /** Base64-encoded binary data */
  data: string;
  mimeType: string;
  /** Original filename if applicable */
  filename?: string;
}

export interface ForgeErrorPayload {
  contentType: 'error';
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recoverable: boolean;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * Trace and operational metadata carried on every ForgeMessage.
 * Follows W3C Trace Context where applicable.
 */
export interface ForgeMessageMetadata {
  /** W3C Trace Context trace-id (32 hex chars). Set by observability layer. */
  traceId?: string;
  /** W3C Trace Context span-id (16 hex chars). */
  spanId?: string;
  /** W3C Trace Context parent span-id. */
  parentSpanId?: string;
  /** Message priority: 'low' for background, 'normal' for default, 'high' for user-facing, 'critical' for safety. */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** Time-to-live in milliseconds. Receivers should discard expired messages. */
  ttlMs?: number;
  /** Delegation token from 01-IDENTITY-TRUST. Proves the sender is authorized to act on behalf of the originator. */
  delegationToken?: string;
  /**
   * Budget allocation for the receiver.
   * Enables cost-aware delegation: "you have 5000 tokens and $0.02 to complete this sub-task."
   */
  budget?: {
    maxTokens?: number;
    maxCostCents?: number;
    maxIterations?: number;
  };
  /** Arbitrary key-value pairs for extensibility. */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ForgeMessage (the envelope)
// ---------------------------------------------------------------------------

/**
 * Universal message envelope for all DzipAgent communication.
 *
 * Every message that crosses an agent boundary -- whether in-process,
 * over HTTP (A2A), JSON-RPC (MCP), or gRPC -- is wrapped in this envelope.
 *
 * @example Request-response pair:
 * ```ts
 * // Agent A sends a request
 * const request: ForgeMessage = {
 *   id: createMessageId(),
 *   type: 'request',
 *   from: 'forge://local/planner',
 *   to: 'forge://local/coder',
 *   protocol: 'internal',
 *   timestamp: Date.now(),
 *   payload: { contentType: 'text', text: 'Implement the auth module' },
 *   metadata: { traceId: '...', budget: { maxTokens: 50000 } },
 * };
 *
 * // Agent B responds
 * const response: ForgeMessage = {
 *   id: createMessageId(),
 *   type: 'response',
 *   from: 'forge://local/coder',
 *   to: 'forge://local/planner',
 *   protocol: 'internal',
 *   timestamp: Date.now(),
 *   correlationId: request.id,
 *   payload: { contentType: 'json', data: { files: ['auth.ts'], status: 'done' } },
 *   metadata: { traceId: request.metadata?.traceId },
 * };
 * ```
 */
export interface ForgeMessage {
  /** Globally unique message ID (UUIDv7). */
  id: ForgeMessageId;

  /** Message type discriminator. */
  type: ForgeMessageType;

  /**
   * Sender URI. Uses the forge:// URI scheme from 01-IDENTITY-TRUST.
   * Examples:
   *   forge://local/planner
   *   forge://tenant-abc/coder
   *   a2a://remote-host:8080/code-reviewer
   *   mcp://filesystem/read_file
   */
  from: string;

  /**
   * Recipient URI. Same scheme as `from`.
   * May be a wildcard for broadcast: forge://local/*
   */
  to: string;

  /** Which protocol this message is intended for / originated from. */
  protocol: ForgeProtocol;

  /** Unix epoch milliseconds when the message was created. */
  timestamp: number;

  /**
   * Links this message to a prior message. Used to:
   * - Link a response to its request
   * - Link stream_chunk/stream_end to the originating request
   * - Link an error to the message that caused it
   */
  correlationId?: ForgeMessageId;

  /**
   * Parent message ID for hierarchical message chains.
   * Used when a request spawns sub-requests (e.g., supervisor delegating to specialists).
   * Enables tree-structured trace reconstruction.
   */
  parentId?: ForgeMessageId;

  /** The message content. Discriminated on `payload.contentType`. */
  payload: ForgePayload;

  /** Trace, budget, and operational metadata. */
  metadata: ForgeMessageMetadata;
}

// ---------------------------------------------------------------------------
// Zod Validation Schemas
// ---------------------------------------------------------------------------

const forgeMessageMetadataSchema = z.object({
  traceId: z.string().length(32).optional(),
  spanId: z.string().length(16).optional(),
  parentSpanId: z.string().length(16).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  ttlMs: z.number().int().positive().optional(),
  delegationToken: z.string().optional(),
  budget: z.object({
    maxTokens: z.number().int().positive().optional(),
    maxCostCents: z.number().positive().optional(),
    maxIterations: z.number().int().positive().optional(),
  }).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict();

const forgePayloadSchema = z.discriminatedUnion('contentType', [
  z.object({ contentType: z.literal('text'), text: z.string() }),
  z.object({
    contentType: z.literal('json'),
    data: z.record(z.string(), z.unknown()),
    schema: z.string().optional(),
  }),
  z.object({
    contentType: z.literal('tool_call'),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    serverId: z.string().optional(),
  }),
  z.object({
    contentType: z.literal('tool_result'),
    toolName: z.string(),
    result: z.string(),
    isError: z.boolean(),
    durationMs: z.number().optional(),
  }),
  z.object({
    contentType: z.literal('task'),
    taskId: z.string(),
    state: z.enum(['submitted', 'working', 'input-required', 'completed', 'failed', 'cancelled']),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    contentType: z.literal('binary'),
    data: z.string(),
    mimeType: z.string(),
    filename: z.string().optional(),
  }),
  z.object({
    contentType: z.literal('error'),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    recoverable: z.boolean(),
  }),
]);

export const forgeMessageSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['request', 'response', 'notification', 'stream_chunk', 'stream_end', 'error']),
  from: z.string().min(1),
  to: z.string().min(1),
  protocol: z.enum(['internal', 'a2a', 'mcp', 'grpc', 'anp', 'http']),
  timestamp: z.number().int().positive(),
  correlationId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  payload: forgePayloadSchema,
  metadata: forgeMessageMetadataSchema,
}).strict();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ForgeMessageValidationResult =
  | { valid: true; message: ForgeMessage }
  | { valid: false; errors: z.ZodIssue[] };

/**
 * Validate a raw object as a ForgeMessage.
 * Returns a discriminated result -- never throws.
 */
export function validateForgeMessage(raw: unknown): ForgeMessageValidationResult {
  const result = forgeMessageSchema.safeParse(raw);
  if (result.success) {
    return { valid: true, message: result.data as ForgeMessage };
  }
  return { valid: false, errors: result.error.issues };
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a ForgeMessage with sensible defaults.
 * Generates ID and timestamp automatically.
 */
export function createForgeMessage(
  fields: Omit<ForgeMessage, 'id' | 'timestamp'> & { id?: ForgeMessageId; timestamp?: number },
): ForgeMessage {
  return {
    id: fields.id ?? createMessageId(),
    timestamp: fields.timestamp ?? Date.now(),
    ...fields,
  } as ForgeMessage;
}

/**
 * Create a response message linked to a request.
 */
export function createResponse(
  request: ForgeMessage,
  payload: ForgePayload,
  from: string,
  metadata?: Partial<ForgeMessageMetadata>,
): ForgeMessage {
  return createForgeMessage({
    type: 'response',
    from,
    to: request.from,
    protocol: request.protocol,
    correlationId: request.id,
    parentId: request.parentId,
    payload,
    metadata: {
      traceId: request.metadata.traceId,
      spanId: request.metadata.spanId,
      ...metadata,
    },
  });
}

/**
 * Create an error response linked to a request.
 */
export function createErrorResponse(
  request: ForgeMessage,
  code: string,
  message: string,
  from: string,
  options?: { recoverable?: boolean; details?: Record<string, unknown> },
): ForgeMessage {
  return createResponse(
    request,
    {
      contentType: 'error',
      code,
      message,
      recoverable: options?.recoverable ?? true,
      details: options?.details,
    },
    from,
  );
}

// ---------------------------------------------------------------------------
// TTL checking
// ---------------------------------------------------------------------------

/**
 * Check if a message has expired based on its ttlMs metadata.
 * Returns true if the message is still valid, false if expired.
 */
export function isMessageAlive(message: ForgeMessage): boolean {
  if (!message.metadata.ttlMs) return true;
  return Date.now() - message.timestamp < message.metadata.ttlMs;
}
```

#### 2.1.2 Design Notes

- **UUIDv7 for IDs**: Time-ordered UUIDs enable efficient indexing and natural sort-by-time without a separate timestamp column in persistence layers.
- **Branded type for ForgeMessageId**: Prevents accidental use of arbitrary strings as message IDs at compile time.
- **Strict Zod schemas**: The `.strict()` modifier rejects unknown fields, preventing schema drift when messages cross process boundaries.
- **ForgePayload discriminated union**: Consumers use `switch (payload.contentType)` for exhaustive handling. TypeScript narrows the type automatically.
- **Budget in metadata**: Enables cost-aware delegation chains. A supervisor can say "you have 5000 tokens to complete this sub-task" and the receiving agent can enforce it via IterationBudget.

---

### F2: ProtocolAdapter Interface (P0, 4h)

> **Owner:** `@dzipagent/core` (`core/src/protocol/adapter.ts`)
> **Depends on:** F1 (ForgeMessage)

The ProtocolAdapter is the abstract interface through which ALL external communication flows. Each transport (in-process, A2A HTTP, MCP JSON-RPC, gRPC) implements this interface.

#### 2.2.1 Interface Contract

```typescript
// core/src/protocol/adapter.ts

import type { ForgeMessage, ForgeProtocol } from './message.js';

// ---------------------------------------------------------------------------
// Adapter lifecycle
// ---------------------------------------------------------------------------

export type AdapterState = 'disconnected' | 'connecting' | 'connected' | 'error' | 'draining';

export interface AdapterHealthStatus {
  state: AdapterState;
  /** Milliseconds since last successful send/receive. */
  lastActivityMs: number;
  /** Pending outbound messages count. */
  pendingCount: number;
  /** Human-readable error from last failure, if any. */
  lastError?: string;
  /** Adapter-specific metadata (e.g., connection pool size for gRPC). */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

export interface SendOptions {
  /** Timeout for this specific send in milliseconds. Overrides adapter default. */
  timeoutMs?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Number of retry attempts on transient failure. Default: adapter-specific. */
  retries?: number;
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export type MessageHandler = (message: ForgeMessage) => void | Promise<void>;

export interface Subscription {
  /** Unsubscribe from this subscription. Idempotent. */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// ProtocolAdapter
// ---------------------------------------------------------------------------

/**
 * Abstract interface for protocol-specific communication adapters.
 *
 * Each adapter manages:
 * - Transport lifecycle (connect/disconnect)
 * - Message serialization for its protocol
 * - Retry/backoff semantics appropriate to its transport
 * - Health reporting
 *
 * Adapters are registered in the ProtocolRouter by their supported protocol(s).
 *
 * @example
 * ```ts
 * const adapter: ProtocolAdapter = new A2AClientAdapter({ baseUrl: 'http://remote:8080' });
 * await adapter.connect();
 *
 * // Send a request and await the response
 * const response = await adapter.send(requestMessage);
 *
 * // Stream responses
 * for await (const chunk of adapter.stream(streamRequest)) {
 *   console.log(chunk.payload);
 * }
 *
 * // Subscribe to incoming messages
 * const sub = adapter.subscribe('forge://local/planner', (msg) => { ... });
 * sub.unsubscribe();
 *
 * await adapter.disconnect();
 * ```
 */
export interface ProtocolAdapter {
  /** Unique adapter instance ID (for logging and registry). */
  readonly adapterId: string;

  /** Which protocol(s) this adapter handles. */
  readonly protocols: readonly ForgeProtocol[];

  /** Current connection state. */
  readonly state: AdapterState;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Establish the transport connection.
   * Resolves when the adapter is ready to send/receive.
   * Non-fatal: returns false on failure instead of throwing.
   */
  connect(): Promise<boolean>;

  /**
   * Gracefully shut down the transport.
   * Drains pending messages (up to a timeout), then closes.
   * Idempotent: calling disconnect() on an already-disconnected adapter is a no-op.
   */
  disconnect(): Promise<void>;

  /**
   * Check if the adapter is connected and healthy.
   */
  isConnected(): boolean;

  /**
   * Detailed health status for monitoring.
   */
  healthCheck(): AdapterHealthStatus;

  // -------------------------------------------------------------------------
  // Send / Receive
  // -------------------------------------------------------------------------

  /**
   * Send a message and await a single response.
   *
   * For request-type messages, this blocks until the correlated response
   * arrives or the timeout is reached.
   *
   * For notification-type messages, this resolves immediately after
   * the message is delivered to the transport (fire-and-forget).
   *
   * @throws ForgeError with code 'ADAPTER_SEND_FAILED' on transport failure
   * @throws ForgeError with code 'ADAPTER_TIMEOUT' if response not received in time
   */
  send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage | null>;

  /**
   * Send a message and receive a stream of responses.
   *
   * Yields stream_chunk messages as they arrive, and completes
   * when a stream_end or error message is received.
   *
   * The returned AsyncGenerator can be aborted via options.signal.
   */
  stream(message: ForgeMessage, options?: SendOptions): AsyncGenerator<ForgeMessage>;

  /**
   * Subscribe to incoming messages matching a target URI pattern.
   *
   * The pattern supports exact match and wildcard:
   * - 'forge://local/planner' -- exact match
   * - 'forge://local/*' -- all local agents
   * - '*' -- all messages (wildcard)
   *
   * Returns a Subscription handle for unsubscribing.
   */
  subscribe(targetPattern: string, handler: MessageHandler): Subscription;
}

// ---------------------------------------------------------------------------
// ProtocolRouter
// ---------------------------------------------------------------------------

/**
 * Routes ForgeMessages to the correct ProtocolAdapter based on the
 * message's `to` URI and `protocol` field.
 *
 * The router maintains a registry of adapters keyed by protocol.
 * When a URI scheme does not directly map to a protocol, the router
 * attempts to infer the protocol from the URI scheme:
 *   forge:// -> 'internal'
 *   a2a://   -> 'a2a'
 *   mcp://   -> 'mcp'
 *   grpc://  -> 'grpc'
 */
export interface ProtocolRouter {
  /**
   * Register an adapter for one or more protocols.
   * If an adapter for the same protocol already exists, it is replaced.
   */
  registerAdapter(adapter: ProtocolAdapter): void;

  /**
   * Remove an adapter by its instance ID. Calls disconnect() on it.
   */
  removeAdapter(adapterId: string): Promise<void>;

  /**
   * Get the adapter for a given protocol. Returns null if none registered.
   */
  getAdapter(protocol: ForgeProtocol): ProtocolAdapter | null;

  /**
   * Resolve which adapter should handle a message based on its `to` URI.
   * Returns null if no suitable adapter is found.
   */
  resolveAdapter(message: ForgeMessage): ProtocolAdapter | null;

  /**
   * Send a message, automatically routing to the correct adapter.
   * Convenience wrapper around resolveAdapter() + adapter.send().
   */
  send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage | null>;

  /**
   * Stream responses, automatically routing to the correct adapter.
   */
  stream(message: ForgeMessage, options?: SendOptions): AsyncGenerator<ForgeMessage>;

  /**
   * Get health status for all registered adapters.
   */
  healthCheck(): Map<string, AdapterHealthStatus>;

  /**
   * Disconnect all adapters and clear the registry.
   */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error codes (extends ForgeErrorCode from core/src/errors/)
// ---------------------------------------------------------------------------

/**
 * New error codes introduced by the protocol layer.
 * These should be added to the ForgeErrorCode union in error-codes.ts.
 */
export type ProtocolErrorCode =
  | 'ADAPTER_NOT_FOUND'
  | 'ADAPTER_SEND_FAILED'
  | 'ADAPTER_TIMEOUT'
  | 'ADAPTER_DISCONNECTED'
  | 'PROTOCOL_NEGOTIATION_FAILED'
  | 'MESSAGE_EXPIRED'
  | 'MESSAGE_VALIDATION_FAILED'
  | 'SERIALIZATION_FAILED';
```

#### 2.2.2 Retry Semantics Per Adapter

Each adapter defines its own retry policy appropriate to its transport:

| Adapter | Default Retries | Backoff Strategy | Retry-Eligible Failures |
|---------|----------------|------------------|------------------------|
| InternalAdapter | 0 | N/A (in-process, no transient failures) | None |
| A2AClientAdapter | 3 | Exponential (100ms, 200ms, 400ms) + jitter | HTTP 429, 502, 503, 504, network errors |
| MCPClientAdapter | 2 | Linear (500ms, 1000ms) | Connection reset, timeout |
| gRPCAdapter | 3 | Exponential (200ms, 400ms, 800ms) | UNAVAILABLE, DEADLINE_EXCEEDED |

Retries are per-send, NOT per-adapter. The `SendOptions.retries` field overrides the adapter default for a specific call.

#### 2.2.3 Adapter Registration in ForgeContainer

```typescript
// core/src/protocol/router.ts

import type { DzipEventBus } from '../events/event-bus.js';
import type { ProtocolAdapter, ProtocolRouter, AdapterHealthStatus, SendOptions } from './adapter.js';
import type { ForgeMessage, ForgeProtocol } from './message.js';

/**
 * Default ProtocolRouter implementation.
 *
 * Emits DzipEventBus events on adapter lifecycle changes:
 * - 'protocol:adapter_registered'
 * - 'protocol:adapter_removed'
 * - 'protocol:send_failed'
 */
export class DefaultProtocolRouter implements ProtocolRouter {
  private adapters = new Map<ForgeProtocol, ProtocolAdapter>();
  private adapterIndex = new Map<string, ProtocolAdapter>();

  constructor(private eventBus?: DzipEventBus) {}

  registerAdapter(adapter: ProtocolAdapter): void {
    for (const protocol of adapter.protocols) {
      this.adapters.set(protocol, adapter);
    }
    this.adapterIndex.set(adapter.adapterId, adapter);
  }

  async removeAdapter(adapterId: string): Promise<void> {
    const adapter = this.adapterIndex.get(adapterId);
    if (!adapter) return;

    await adapter.disconnect();

    for (const protocol of adapter.protocols) {
      if (this.adapters.get(protocol) === adapter) {
        this.adapters.delete(protocol);
      }
    }
    this.adapterIndex.delete(adapterId);
  }

  getAdapter(protocol: ForgeProtocol): ProtocolAdapter | null {
    return this.adapters.get(protocol) ?? null;
  }

  resolveAdapter(message: ForgeMessage): ProtocolAdapter | null {
    // 1. Try explicit protocol field
    const byProtocol = this.adapters.get(message.protocol);
    if (byProtocol) return byProtocol;

    // 2. Infer from URI scheme
    const protocol = this.inferProtocol(message.to);
    if (protocol) return this.adapters.get(protocol) ?? null;

    return null;
  }

  async send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage | null> {
    const adapter = this.resolveAdapter(message);
    if (!adapter) return null;
    return adapter.send(message, options);
  }

  async *stream(message: ForgeMessage, options?: SendOptions): AsyncGenerator<ForgeMessage> {
    const adapter = this.resolveAdapter(message);
    if (!adapter) return;
    yield* adapter.stream(message, options);
  }

  healthCheck(): Map<string, AdapterHealthStatus> {
    const results = new Map<string, AdapterHealthStatus>();
    for (const [id, adapter] of this.adapterIndex) {
      results.set(id, adapter.healthCheck());
    }
    return results;
  }

  async shutdown(): Promise<void> {
    const promises = Array.from(this.adapterIndex.values()).map(a => a.disconnect());
    await Promise.all(promises);
    this.adapters.clear();
    this.adapterIndex.clear();
  }

  private inferProtocol(uri: string): ForgeProtocol | null {
    if (uri.startsWith('forge://')) return 'internal';
    if (uri.startsWith('a2a://')) return 'a2a';
    if (uri.startsWith('mcp://')) return 'mcp';
    if (uri.startsWith('grpc://')) return 'grpc';
    if (uri.startsWith('http://') || uri.startsWith('https://')) return 'http';
    return null;
  }
}
```

---

### F3: InternalAdapter (P0, included in F2)

> **Owner:** `@dzipagent/core` (`core/src/protocol/internal-adapter.ts`)
> **Depends on:** F1, F2, existing DzipEventBus and AgentBus

Wraps DzipEventBus and AgentBus for in-process agent-to-agent communication using the ProtocolAdapter interface. This is the default adapter -- available even with zero configuration.

#### 2.3.1 Implementation

```typescript
// core/src/protocol/internal-adapter.ts

import type { DzipEventBus } from '../events/event-bus.js';
import type { AgentBus } from '../events/agent-bus.js';
import type {
  ProtocolAdapter,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
} from './adapter.js';
import type { ForgeMessage, ForgeProtocol } from './message.js';

/**
 * In-process ProtocolAdapter that routes messages through DzipEventBus
 * and AgentBus. Zero-copy: messages are passed by reference, not serialized.
 *
 * Routing logic:
 * - Messages with `to` matching 'forge://local/<agentId>' are delivered
 *   to the AgentBus channel named '<agentId>'.
 * - Messages with `to` of 'forge://local/*' are broadcast to all
 *   AgentBus subscribers.
 * - DzipEventBus receives a 'protocol:message_routed' event for
 *   every message (for observability).
 *
 * Response correlation:
 * - When send() is called with a 'request' type message, the adapter
 *   subscribes to the sender's channel for a response with matching
 *   correlationId, with a timeout.
 */
export class InternalAdapter implements ProtocolAdapter {
  readonly adapterId = 'internal';
  readonly protocols: readonly ForgeProtocol[] = ['internal'] as const;

  private _state: AdapterState = 'disconnected';
  private lastActivityMs = 0;
  private pendingRequests = new Map<string, {
    resolve: (msg: ForgeMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly eventBus: DzipEventBus,
    private readonly agentBus: AgentBus,
    private readonly options?: { defaultTimeoutMs?: number },
  ) {}

  get state(): AdapterState { return this._state; }

  async connect(): Promise<boolean> {
    this._state = 'connected';
    return true;
  }

  async disconnect(): Promise<void> {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
    }
    this._state = 'disconnected';
  }

  isConnected(): boolean {
    return this._state === 'connected';
  }

  healthCheck(): AdapterHealthStatus {
    return {
      state: this._state,
      lastActivityMs: this.lastActivityMs,
      pendingCount: this.pendingRequests.size,
    };
  }

  async send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage | null> {
    if (this._state !== 'connected') return null;

    const targetAgent = this.extractAgentId(message.to);
    if (!targetAgent) return null;

    this.lastActivityMs = Date.now();

    // Deliver to AgentBus (zero-copy -- pass the ForgeMessage as payload)
    this.agentBus.publish(
      this.extractAgentId(message.from) ?? 'unknown',
      targetAgent,
      { __forgeMessage: message } as Record<string, unknown>,
    );

    // For request type, wait for correlated response
    if (message.type === 'request') {
      const timeoutMs = options?.timeoutMs ?? this.options?.defaultTimeoutMs ?? 30_000;
      return this.awaitResponse(message, timeoutMs, options?.signal);
    }

    // For notifications, return immediately
    return null;
  }

  async *stream(message: ForgeMessage, options?: SendOptions): AsyncGenerator<ForgeMessage> {
    if (this._state !== 'connected') return;

    const targetAgent = this.extractAgentId(message.to);
    if (!targetAgent) return;

    // Deliver the request
    this.agentBus.publish(
      this.extractAgentId(message.from) ?? 'unknown',
      targetAgent,
      { __forgeMessage: message } as Record<string, unknown>,
    );

    // Listen for stream_chunk and stream_end messages
    const senderChannel = this.extractAgentId(message.from);
    if (!senderChannel) return;

    const chunks: ForgeMessage[] = [];
    let done = false;
    let resolveNext: ((value: IteratorResult<ForgeMessage>) => void) | null = null;

    const unsub = this.agentBus.subscribe(senderChannel, `stream-${message.id}`, (agentMsg) => {
      const forgeMsg = (agentMsg.payload as Record<string, unknown>)['__forgeMessage'] as ForgeMessage | undefined;
      if (!forgeMsg || forgeMsg.correlationId !== message.id) return;

      if (forgeMsg.type === 'stream_end' || forgeMsg.type === 'error') {
        done = true;
        if (resolveNext) resolveNext({ value: forgeMsg, done: false });
      } else if (forgeMsg.type === 'stream_chunk') {
        if (resolveNext) {
          resolveNext({ value: forgeMsg, done: false });
          resolveNext = null;
        } else {
          chunks.push(forgeMsg);
        }
      }
    });

    try {
      while (!done) {
        if (options?.signal?.aborted) break;

        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else {
          const result = await new Promise<IteratorResult<ForgeMessage>>((resolve) => {
            resolveNext = resolve;
          });
          if (result.done) break;
          yield result.value;
          if (result.value.type === 'stream_end' || result.value.type === 'error') break;
        }
      }
    } finally {
      unsub();
    }
  }

  subscribe(targetPattern: string, handler: MessageHandler): Subscription {
    const agentId = this.extractAgentId(targetPattern);
    const channel = agentId ?? '*';
    const subscriberId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const unsub = this.agentBus.subscribe(channel, subscriberId, (agentMsg) => {
      const forgeMsg = (agentMsg.payload as Record<string, unknown>)['__forgeMessage'] as ForgeMessage | undefined;
      if (forgeMsg) {
        void handler(forgeMsg);
      }
    });

    return { unsubscribe: unsub };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractAgentId(uri: string): string | null {
    // forge://local/agent-id -> agent-id
    const match = uri.match(/^forge:\/\/[^/]+\/(.+)$/);
    return match?.[1] ?? null;
  }

  private awaitResponse(
    request: ForgeMessage,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ForgeMessage | null> {
    return new Promise((resolve) => {
      const senderChannel = this.extractAgentId(request.from);
      if (!senderChannel) { resolve(null); return; }

      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);

      const unsub = this.agentBus.subscribe(senderChannel, `response-${request.id}`, (agentMsg) => {
        const forgeMsg = (agentMsg.payload as Record<string, unknown>)['__forgeMessage'] as ForgeMessage | undefined;
        if (forgeMsg && forgeMsg.correlationId === request.id) {
          cleanup();
          resolve(forgeMsg);
        }
      });

      const onAbort = () => {
        cleanup();
        resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        unsub();
        signal?.removeEventListener('abort', onAbort);
        this.pendingRequests.delete(request.id);
      };

      this.pendingRequests.set(request.id, { resolve, timer });
    });
  }
}
```

#### 2.3.2 Design Notes

- **Zero-copy**: In-process messages are passed by reference. The `__forgeMessage` wrapper in AgentBus payload is a sentinel pattern -- AgentBus handlers that are NOT protocol-aware simply see a record with an opaque key; protocol-aware handlers extract the ForgeMessage.
- **Backward compatible**: Existing AgentBus.publish() and subscribe() calls continue to work unchanged. InternalAdapter is layered on top.
- **No serialization**: Unlike A2A or gRPC adapters, InternalAdapter never serializes messages. This is deliberate -- serialization is only needed when crossing process boundaries.

---

### F4: A2A Client Adapter (P0, 12h)

> **Owner:** `@dzipagent/a2a` (new package)
> **Depends on:** F1, F2, 01-IDENTITY-TRUST (Bearer auth)

Full implementation of the Google Agent-to-Agent (A2A) protocol client. The current server-side A2A support in `@dzipagent/server` provides task endpoints; this feature adds the CLIENT side so DzipAgent can call other A2A-compatible agents.

#### 2.4.1 Package: `@dzipagent/a2a`

```
packages/forgeagent-a2a/
  package.json          # depends on @dzipagent/core (peer)
  tsconfig.json
  tsup.config.ts
  src/
    index.ts
    client/
      a2a-client-adapter.ts    # ProtocolAdapter implementation
      a2a-http-transport.ts    # Raw HTTP transport (fetch-based)
      a2a-types.ts             # A2A protocol types (Agent Card, Task, Message)
      agent-card-cache.ts      # Caches fetched agent cards with TTL
    server/
      a2a-server-adapter.ts    # Server-side adapter (integrates with Hono)
      task-manager.ts          # Upgraded from server/a2a/task-handler.ts
    bridge/
      protocol-bridge.ts       # MCP <-> A2A translation (F7)
    __tests__/
      a2a-client.test.ts
      agent-card-cache.test.ts
      protocol-bridge.test.ts
      mock-a2a-server.ts       # Test fixture
```

#### 2.4.2 A2A Protocol Types

```typescript
// a2a/src/client/a2a-types.ts

/**
 * A2A protocol types aligned with the Google A2A specification.
 * Reference: https://google.github.io/A2A/
 */

// ---------------------------------------------------------------------------
// Agent Card (discovery)
// ---------------------------------------------------------------------------

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  /** Supported protocol versions */
  protocolVersion?: string;
  capabilities: A2ACapability[];
  authentication?: A2AAuthentication;
  skills?: A2ASkill[];
  /** Provider metadata */
  provider?: {
    organization: string;
    url?: string;
  };
  /** Default input/output modes */
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export interface A2ACapability {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface A2AAuthentication {
  type: 'bearer' | 'api-key' | 'oauth2' | 'none';
  /** OAuth2 specific */
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

export interface A2ASkill {
  name: string;
  description: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface A2ATask {
  id: string;
  state: A2ATaskState;
  input: A2AMessage;
  output?: A2AMessage;
  error?: A2AError;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** History of state transitions */
  history?: A2ATaskEvent[];
}

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2AMessagePart[];
}

export type A2AMessagePart =
  | { type: 'text'; text: string }
  | { type: 'data'; data: Record<string, unknown>; mimeType?: string }
  | { type: 'file'; uri: string; mimeType?: string; name?: string };

export interface A2AError {
  code: string;
  message: string;
  data?: unknown;
}

export interface A2ATaskEvent {
  state: A2ATaskState;
  timestamp: string;
  message?: A2AMessage;
}

// ---------------------------------------------------------------------------
// JSON-RPC (A2A wire protocol)
// ---------------------------------------------------------------------------

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: A2AMethod;
  params: Record<string, unknown>;
}

export type A2AMethod =
  | 'tasks/send'
  | 'tasks/sendSubscribe'
  | 'tasks/get'
  | 'tasks/list'
  | 'tasks/cancel'
  | 'tasks/pushNotification/set'
  | 'tasks/pushNotification/get';

export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
```

#### 2.4.3 Agent Card Cache

```typescript
// a2a/src/client/agent-card-cache.ts

import type { A2AAgentCard } from './a2a-types.js';

interface CachedCard {
  card: A2AAgentCard;
  fetchedAt: number;
  url: string;
}

/**
 * Caches fetched A2A agent cards with configurable TTL.
 * Cards are fetched from /.well-known/agent.json endpoints.
 */
export class AgentCardCache {
  private cache = new Map<string, CachedCard>();

  constructor(
    private readonly options?: {
      /** Cache TTL in milliseconds (default: 5 minutes) */
      ttlMs?: number;
      /** Custom fetch function for testing */
      fetchFn?: typeof fetch;
    },
  ) {}

  /**
   * Fetch an agent card from a remote endpoint.
   * Returns cached version if still valid.
   *
   * @param baseUrl - The base URL of the A2A agent (e.g., 'http://remote:8080')
   */
  async getCard(baseUrl: string): Promise<A2AAgentCard | null> {
    const ttl = this.options?.ttlMs ?? 5 * 60 * 1000;
    const cached = this.cache.get(baseUrl);

    if (cached && Date.now() - cached.fetchedAt < ttl) {
      return cached.card;
    }

    try {
      const fetchFn = this.options?.fetchFn ?? fetch;
      const url = `${baseUrl.replace(/\/$/, '')}/.well-known/agent.json`;
      const response = await fetchFn(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return null;

      const card = await response.json() as A2AAgentCard;
      this.cache.set(baseUrl, { card, fetchedAt: Date.now(), url });
      return card;
    } catch {
      return null;
    }
  }

  /** Invalidate a cached card. */
  invalidate(baseUrl: string): void {
    this.cache.delete(baseUrl);
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }
}
```

#### 2.4.4 A2A Client Adapter

```typescript
// a2a/src/client/a2a-client-adapter.ts

import type {
  ProtocolAdapter,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
} from '@dzipagent/core';
import type { ForgeMessage, ForgeProtocol } from '@dzipagent/core';
import { createForgeMessage, createMessageId } from '@dzipagent/core';
import type { A2AAgentCard, A2ATask, A2AJsonRpcResponse } from './a2a-types.js';
import { AgentCardCache } from './agent-card-cache.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface A2AClientAdapterConfig {
  /**
   * Map of agent names to their base URLs.
   * Example: { 'code-reviewer': 'http://reviewer:8080' }
   */
  agents: Record<string, string>;

  /** Authentication for outbound requests. */
  auth?: {
    type: 'bearer' | 'api-key';
    token: string;
    /** Header name for api-key auth (default: 'X-API-Key') */
    headerName?: string;
  };

  /** Default timeout for A2A requests in milliseconds (default: 60_000). */
  defaultTimeoutMs?: number;

  /** Maximum retry attempts for transient failures (default: 3). */
  maxRetries?: number;

  /** Base delay for exponential backoff in milliseconds (default: 100). */
  retryBaseDelayMs?: number;

  /** Custom fetch function for testing. */
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * ProtocolAdapter for Google A2A protocol communication.
 *
 * Supports:
 * - SendMessage (tasks/send) -- synchronous task submission
 * - SendStreamingMessage (tasks/sendSubscribe) -- SSE streaming
 * - GetTask (tasks/get) -- poll task status
 * - ListTasks (tasks/list) -- enumerate tasks
 * - CancelTask (tasks/cancel) -- cancel a running task
 * - Agent Card fetching and caching
 *
 * Authentication: Bearer token or API key, configured at adapter level.
 * Retry: exponential backoff with jitter on HTTP 429, 502, 503, 504.
 *
 * @example
 * ```ts
 * const adapter = new A2AClientAdapter({
 *   agents: {
 *     'code-reviewer': 'http://reviewer-service:8080',
 *     'test-runner': 'http://test-service:8080',
 *   },
 *   auth: { type: 'bearer', token: process.env.A2A_TOKEN! },
 * });
 *
 * await adapter.connect();
 *
 * // Send a task to code-reviewer
 * const response = await adapter.send(createForgeMessage({
 *   type: 'request',
 *   from: 'forge://local/planner',
 *   to: 'a2a://code-reviewer',
 *   protocol: 'a2a',
 *   payload: {
 *     contentType: 'task',
 *     taskId: 'task-1',
 *     state: 'submitted',
 *     input: { files: ['auth.ts'] },
 *   },
 *   metadata: {},
 * }));
 * ```
 */
export class A2AClientAdapter implements ProtocolAdapter {
  readonly adapterId: string;
  readonly protocols: readonly ForgeProtocol[] = ['a2a'] as const;

  private _state: AdapterState = 'disconnected';
  private lastActivityMs = 0;
  private cardCache: AgentCardCache;
  private cachedCards = new Map<string, A2AAgentCard>();
  private subscriptions = new Map<string, Set<MessageHandler>>();
  private fetchFn: typeof fetch;

  constructor(private readonly config: A2AClientAdapterConfig) {
    this.adapterId = `a2a-client-${Date.now()}`;
    this.fetchFn = config.fetchFn ?? fetch;
    this.cardCache = new AgentCardCache({ fetchFn: this.fetchFn });
  }

  get state(): AdapterState { return this._state; }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async connect(): Promise<boolean> {
    this._state = 'connecting';

    try {
      // Pre-fetch agent cards for all configured agents
      const results = await Promise.allSettled(
        Object.entries(this.config.agents).map(async ([name, url]) => {
          const card = await this.cardCache.getCard(url);
          if (card) this.cachedCards.set(name, card);
          return { name, card };
        }),
      );

      // At least one agent card must be fetchable
      const anySuccess = results.some(
        r => r.status === 'fulfilled' && r.value.card !== null,
      );

      if (anySuccess || Object.keys(this.config.agents).length === 0) {
        this._state = 'connected';
        return true;
      }

      this._state = 'error';
      return false;
    } catch {
      this._state = 'error';
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.subscriptions.clear();
    this.cachedCards.clear();
    this.cardCache.clear();
    this._state = 'disconnected';
  }

  isConnected(): boolean {
    return this._state === 'connected';
  }

  healthCheck(): AdapterHealthStatus {
    return {
      state: this._state,
      lastActivityMs: this.lastActivityMs,
      pendingCount: 0,
      details: {
        configuredAgents: Object.keys(this.config.agents).length,
        cachedCards: this.cachedCards.size,
      },
    };
  }

  // -----------------------------------------------------------------------
  // A2A-specific public methods
  // -----------------------------------------------------------------------

  /**
   * Fetch the agent card for a remote agent.
   */
  async getAgentCard(agentName: string): Promise<A2AAgentCard | null> {
    const url = this.config.agents[agentName];
    if (!url) return null;
    return this.cardCache.getCard(url);
  }

  /**
   * Get a task by ID from a remote agent.
   */
  async getTask(agentName: string, taskId: string): Promise<A2ATask | null> {
    const url = this.config.agents[agentName];
    if (!url) return null;

    const response = await this.jsonRpcCall(url, 'tasks/get', { id: taskId });
    return (response?.result as A2ATask) ?? null;
  }

  /**
   * List tasks on a remote agent, optionally filtered by state.
   */
  async listTasks(
    agentName: string,
    filter?: { state?: string },
  ): Promise<A2ATask[]> {
    const url = this.config.agents[agentName];
    if (!url) return [];

    const response = await this.jsonRpcCall(url, 'tasks/list', filter ?? {});
    const result = response?.result as { tasks?: A2ATask[] } | undefined;
    return result?.tasks ?? [];
  }

  /**
   * Cancel a task on a remote agent.
   */
  async cancelTask(agentName: string, taskId: string): Promise<boolean> {
    const url = this.config.agents[agentName];
    if (!url) return false;

    const response = await this.jsonRpcCall(url, 'tasks/cancel', { id: taskId });
    return response?.result !== undefined;
  }

  // -----------------------------------------------------------------------
  // ProtocolAdapter: send
  // -----------------------------------------------------------------------

  async send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage | null> {
    if (this._state !== 'connected') return null;

    const agentName = this.extractAgentName(message.to);
    if (!agentName) return null;

    const url = this.config.agents[agentName];
    if (!url) return null;

    this.lastActivityMs = Date.now();

    // Translate ForgeMessage -> A2A JSON-RPC request
    const a2aParams = this.forgeMessageToA2AParams(message);

    const response = await this.jsonRpcCallWithRetry(
      url,
      'tasks/send',
      a2aParams,
      options,
    );

    if (!response) return null;

    // Translate A2A response -> ForgeMessage
    return this.a2aResponseToForgeMessage(response, message);
  }

  // -----------------------------------------------------------------------
  // ProtocolAdapter: stream (SSE)
  // -----------------------------------------------------------------------

  async *stream(message: ForgeMessage, options?: SendOptions): AsyncGenerator<ForgeMessage> {
    if (this._state !== 'connected') return;

    const agentName = this.extractAgentName(message.to);
    if (!agentName) return;

    const url = this.config.agents[agentName];
    if (!url) return;

    this.lastActivityMs = Date.now();

    const a2aParams = this.forgeMessageToA2AParams(message);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      method: 'tasks/sendSubscribe',
      params: a2aParams,
    });

    const timeoutMs = options?.timeoutMs ?? this.config.defaultTimeoutMs ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Chain the external signal if provided
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetchFn(`${url}/a2a`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.authHeaders(),
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok || !response.body) return;

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') return;

          try {
            const event = JSON.parse(dataStr) as {
              state?: string;
              output?: { parts?: Array<{ type: string; text?: string }> };
              error?: { code: string; message: string };
            };

            const forgeMsg = this.sseEventToForgeMessage(event, message);
            if (forgeMsg) yield forgeMsg;

            // If terminal state, stop
            if (event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled') {
              return;
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // -----------------------------------------------------------------------
  // ProtocolAdapter: subscribe
  // -----------------------------------------------------------------------

  subscribe(targetPattern: string, handler: MessageHandler): Subscription {
    let handlers = this.subscriptions.get(targetPattern);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(targetPattern, handlers);
    }
    handlers.add(handler);

    return {
      unsubscribe: () => {
        handlers?.delete(handler);
        if (handlers?.size === 0) {
          this.subscriptions.delete(targetPattern);
        }
      },
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private extractAgentName(uri: string): string | null {
    // a2a://agent-name or a2a://agent-name/path
    const match = uri.match(/^a2a:\/\/([^/]+)/);
    return match?.[1] ?? null;
  }

  private authHeaders(): Record<string, string> {
    if (!this.config.auth) return {};

    if (this.config.auth.type === 'bearer') {
      return { Authorization: `Bearer ${this.config.auth.token}` };
    }
    if (this.config.auth.type === 'api-key') {
      const headerName = this.config.auth.headerName ?? 'X-API-Key';
      return { [headerName]: this.config.auth.token };
    }
    return {};
  }

  private forgeMessageToA2AParams(message: ForgeMessage): Record<string, unknown> {
    const payload = message.payload;

    if (payload.contentType === 'task') {
      return {
        id: payload.taskId,
        input: payload.input,
        metadata: {
          ...message.metadata.extensions,
          forgeCorrelationId: message.correlationId,
          forgeBudget: message.metadata.budget,
        },
      };
    }

    if (payload.contentType === 'text') {
      return {
        input: {
          role: 'user',
          parts: [{ type: 'text', text: payload.text }],
        },
        metadata: {
          forgeCorrelationId: message.correlationId,
          forgeBudget: message.metadata.budget,
        },
      };
    }

    // Generic: wrap entire payload as data part
    return {
      input: {
        role: 'user',
        parts: [{ type: 'data', data: payload as Record<string, unknown> }],
      },
    };
  }

  private a2aResponseToForgeMessage(
    response: A2AJsonRpcResponse,
    request: ForgeMessage,
  ): ForgeMessage {
    const task = response.result as A2ATask | undefined;

    if (response.error) {
      return createForgeMessage({
        type: 'error',
        from: request.to,
        to: request.from,
        protocol: 'a2a',
        correlationId: request.id,
        payload: {
          contentType: 'error',
          code: String(response.error.code),
          message: response.error.message,
          recoverable: true,
        },
        metadata: { traceId: request.metadata.traceId },
      });
    }

    return createForgeMessage({
      type: 'response',
      from: request.to,
      to: request.from,
      protocol: 'a2a',
      correlationId: request.id,
      payload: {
        contentType: 'task',
        taskId: task?.id ?? 'unknown',
        state: (task?.state ?? 'submitted') as 'submitted',
        input: task?.input,
        output: task?.output,
        error: task?.error?.message,
      },
      metadata: { traceId: request.metadata.traceId },
    });
  }

  private sseEventToForgeMessage(
    event: Record<string, unknown>,
    request: ForgeMessage,
  ): ForgeMessage | null {
    const state = event['state'] as string | undefined;
    const output = event['output'] as { parts?: Array<{ text?: string }> } | undefined;
    const text = output?.parts?.map(p => p.text ?? '').join('') ?? '';

    if (!state && !text) return null;

    const isTerminal = state === 'completed' || state === 'failed' || state === 'cancelled';

    return createForgeMessage({
      type: isTerminal ? 'stream_end' : 'stream_chunk',
      from: request.to,
      to: request.from,
      protocol: 'a2a',
      correlationId: request.id,
      payload: state
        ? {
            contentType: 'task',
            taskId: (event['id'] as string) ?? 'unknown',
            state: state as 'working',
            output: text ? { text } : undefined,
          }
        : { contentType: 'text', text },
      metadata: { traceId: request.metadata.traceId },
    });
  }

  private async jsonRpcCall(
    baseUrl: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<A2AJsonRpcResponse | null> {
    try {
      const response = await this.fetchFn(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
        signal: AbortSignal.timeout(this.config.defaultTimeoutMs ?? 60_000),
      });

      if (!response.ok) return null;
      return await response.json() as A2AJsonRpcResponse;
    } catch {
      return null;
    }
  }

  private async jsonRpcCallWithRetry(
    baseUrl: string,
    method: string,
    params: Record<string, unknown>,
    options?: SendOptions,
  ): Promise<A2AJsonRpcResponse | null> {
    const maxRetries = options?.retries ?? this.config.maxRetries ?? 3;
    const baseDelay = this.config.retryBaseDelayMs ?? 100;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const timeoutMs = options?.timeoutMs ?? this.config.defaultTimeoutMs ?? 60_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        if (options?.signal) {
          options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
          const response = await this.fetchFn(`${baseUrl}/a2a`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...this.authHeaders(),
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: Date.now(),
              method,
              params,
            }),
            signal: controller.signal,
          });

          if (response.ok) {
            return await response.json() as A2AJsonRpcResponse;
          }

          // Retry on transient HTTP errors
          const retryable = [429, 502, 503, 504];
          if (!retryable.includes(response.status) || attempt === maxRetries) {
            return null;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        if (attempt === maxRetries) return null;
      }

      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    return null;
  }
}
```

---

### F5: MCP Resources Support (P1, 8h)

> **Owner:** `@dzipagent/core` (`core/src/mcp/mcp-resources.ts`)
> **Depends on:** Existing MCPClient

Extends the existing MCPClient to support MCP Resources -- URI-addressed data that MCP servers expose for reading and subscription. Resources bridge the gap between MCP tools (execute actions) and MCP resources (read data).

#### 2.5.1 Interface

```typescript
// core/src/mcp/mcp-resources.ts

import type { MCPClient } from './mcp-client.js';

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

export interface MCPResource {
  /** URI identifying the resource (e.g., file:///workspace/src/index.ts) */
  uri: string;
  /** Human-readable name */
  name: string;
  /** MIME type of the resource content */
  mimeType?: string;
  /** Optional description */
  description?: string;
  /** Which MCP server provides this resource */
  serverId: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  /** Text content (for text/* MIME types) */
  text?: string;
  /** Base64-encoded binary content (for non-text MIME types) */
  blob?: string;
}

export type ResourceChangeHandler = (uri: string, content: MCPResourceContent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// ResourceManager
// ---------------------------------------------------------------------------

/**
 * Manages MCP Resources across all connected MCP servers.
 *
 * Capabilities:
 * - List available resources from each server
 * - Read resource contents by URI
 * - Subscribe to resource change notifications
 * - Cache resource contents with configurable TTL
 *
 * @example
 * ```ts
 * const resources = new MCPResourceManager(mcpClient);
 *
 * // List all resources from connected servers
 * const allResources = await resources.list();
 *
 * // Read a specific resource
 * const content = await resources.read('file:///workspace/src/index.ts');
 *
 * // Subscribe to changes
 * resources.onChanged('file:///workspace/**', (uri, content) => {
 *   console.log(`Resource changed: ${uri}`);
 * });
 * ```
 */
export interface MCPResourceManager {
  /** List all available resources across connected MCP servers. */
  list(serverId?: string): Promise<MCPResource[]>;

  /** Read the content of a specific resource by URI. */
  read(uri: string): Promise<MCPResourceContent | null>;

  /**
   * Subscribe to resource change notifications.
   * Pattern supports exact URI or glob patterns.
   * Returns unsubscribe function.
   */
  onChanged(uriPattern: string, handler: ResourceChangeHandler): () => void;

  /**
   * Subscribe to a resource on the MCP server.
   * The server will send notifications when the resource changes.
   */
  subscribe(uri: string): Promise<boolean>;

  /** Unsubscribe from a resource. */
  unsubscribe(uri: string): Promise<boolean>;
}
```

#### 2.5.2 Memory Integration

Resources can serve as memory sources. When a resource changes, the memory system can be notified to update its index:

```typescript
// Integration point (not a new file -- wired in DzipAgent config)

/**
 * Example: connect MCP resources to the memory system.
 *
 * resourceManager.onChanged('file://workspace/**', async (uri, content) => {
 *   if (content.text) {
 *     await memoryService.put('resource-cache', uri, {
 *       text: content.text,
 *       metadata: { uri, mimeType: content.mimeType, updatedAt: Date.now() },
 *     });
 *   }
 * });
 */
```

---

### F6: MCP Sampling Support (P1, 8h)

> **Owner:** `@dzipagent/core` (`core/src/mcp/mcp-sampling.ts`)
> **Depends on:** Existing MCPClient, ModelRegistry

MCP Sampling allows MCP servers to request LLM inference from the host (DzipAgent). This is the inverse of tool calling: instead of DzipAgent calling the server's tools, the server asks DzipAgent to run an LLM completion.

#### 2.6.1 Interface

```typescript
// core/src/mcp/mcp-sampling.ts

import type { ModelTier } from '../llm/model-registry.js';

// ---------------------------------------------------------------------------
// Sampling types
// ---------------------------------------------------------------------------

export interface MCPSamplingRequest {
  /** Messages for the LLM (in MCP message format) */
  messages: Array<{
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
  }>;
  /** Model preference hint (not binding -- host decides) */
  modelPreferences?: {
    hints?: Array<{ name: string }>;
    /** Minimum cost tier the server requests */
    costPriority?: number;
    /** Minimum speed tier the server requests */
    speedPriority?: number;
    /** Minimum intelligence tier the server requests */
    intelligencePriority?: number;
  };
  /** System prompt requested by the MCP server */
  systemPrompt?: string;
  /** Include context from MCP server */
  includeContext?: 'none' | 'thisServer' | 'allServers';
  /** Temperature hint */
  temperature?: number;
  /** Max tokens hint */
  maxTokens?: number;
  /** Stop sequences */
  stopSequences?: string[];
}

export interface MCPSamplingResponse {
  role: 'assistant';
  content: { type: 'text'; text: string };
  model: string;
  /** Optional token usage for budget tracking */
  usage?: { inputTokens: number; outputTokens: number };
  /** Reason the generation stopped */
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

// ---------------------------------------------------------------------------
// Sampling handler
// ---------------------------------------------------------------------------

export interface MCPSamplingPolicy {
  /** Which MCP server IDs are allowed to request sampling. */
  allowedServers: Set<string>;
  /** Maximum tokens per sampling request. */
  maxTokensPerRequest: number;
  /** Maximum total tokens across all sampling requests in a session. */
  maxTotalTokens: number;
  /** Which model tier to use for sampling (default: 'chat'). */
  defaultModelTier: ModelTier;
  /**
   * Optional human-in-the-loop approval.
   * If set, called before each sampling request. Must return true to proceed.
   */
  approvalFn?: (request: MCPSamplingRequest, serverId: string) => Promise<boolean>;
}

/**
 * Handles MCP sampling requests by routing them through ModelRegistry.
 *
 * Security considerations:
 * - Only servers in the allowlist can request sampling
 * - Per-request and session-wide token limits are enforced
 * - The host's system prompt is NEVER exposed to the MCP server
 * - Optional human-in-the-loop approval before each inference
 *
 * @example
 * ```ts
 * const handler = new MCPSamplingHandler(modelRegistry, {
 *   allowedServers: new Set(['trusted-server']),
 *   maxTokensPerRequest: 4096,
 *   maxTotalTokens: 50_000,
 *   defaultModelTier: 'chat',
 * });
 *
 * // Register with MCPClient
 * mcpClient.setSamplingHandler(handler);
 * ```
 */
export interface MCPSamplingHandler {
  /**
   * Handle a sampling request from an MCP server.
   * Returns null if the request is rejected (policy violation).
   */
  handleSamplingRequest(
    request: MCPSamplingRequest,
    serverId: string,
  ): Promise<MCPSamplingResponse | null>;

  /** Get current token usage for budget tracking. */
  getUsage(): { totalTokensUsed: number; requestCount: number };

  /** Reset usage counters (e.g., for a new session). */
  resetUsage(): void;
}
```

---

### F7: Protocol Bridge (P1, 8h)

> **Owner:** `@dzipagent/a2a` (`a2a/src/bridge/protocol-bridge.ts`)
> **Depends on:** F1, F2, F4, existing MCP types

Enables automatic translation between MCP tools and A2A capabilities. This allows an agent's MCP tools to be discoverable via A2A, and vice versa.

#### 2.7.1 Interface

```typescript
// a2a/src/bridge/protocol-bridge.ts

import type { MCPToolDescriptor } from '@dzipagent/core';
import type { A2ACapability, A2AAgentCard } from '../client/a2a-types.js';

// ---------------------------------------------------------------------------
// Bridge configuration
// ---------------------------------------------------------------------------

export interface ProtocolBridgeConfig {
  /**
   * Which MCP tools to expose as A2A capabilities.
   * - 'all': expose everything
   * - 'none': expose nothing (bridge disabled in this direction)
   * - string[]: explicit allowlist of tool names
   */
  mcpToA2A: 'all' | 'none' | string[];

  /**
   * Which A2A capabilities to expose as MCP tools.
   * Same semantics as mcpToA2A.
   */
  a2aToMCP: 'all' | 'none' | string[];

  /**
   * Prefix for bridged tool names to avoid collisions.
   * Example: 'a2a_' prefix turns 'code-review' into 'a2a_code-review'
   */
  toolNamePrefix?: {
    mcpToA2A?: string;
    a2aToMCP?: string;
  };
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Translates between MCP tool descriptors and A2A capabilities.
 *
 * Use cases:
 * 1. Expose local MCP tools as A2A capabilities in the agent card
 * 2. Make remote A2A agent capabilities available as MCP tools
 * 3. Schema compatibility checking before bridging
 *
 * @example
 * ```ts
 * const bridge = new ProtocolBridge({
 *   mcpToA2A: ['read_file', 'write_file', 'search'],
 *   a2aToMCP: 'all',
 * });
 *
 * // Get A2A capabilities from MCP tools
 * const capabilities = bridge.mcpToolsToA2ACapabilities(mcpTools);
 *
 * // Get MCP tool descriptors from A2A agent card
 * const tools = bridge.a2aCapabilitiesToMCPTools(agentCard);
 * ```
 */
export interface ProtocolBridge {
  /**
   * Convert MCP tool descriptors to A2A capabilities.
   * Filters based on the mcpToA2A config.
   */
  mcpToolsToA2ACapabilities(tools: MCPToolDescriptor[]): A2ACapability[];

  /**
   * Convert A2A capabilities to MCP tool descriptors.
   * Filters based on the a2aToMCP config.
   */
  a2aCapabilitiesToMCPTools(
    card: A2AAgentCard,
    serverId: string,
  ): MCPToolDescriptor[];

  /**
   * Check if an MCP tool's input schema is compatible with A2A's
   * expected schema format. Returns issues found.
   */
  checkSchemaCompatibility(
    tool: MCPToolDescriptor,
  ): { compatible: boolean; issues: string[] };

  /**
   * Translate a ForgeMessage from MCP protocol format to A2A format.
   * Used for runtime message translation (not just schema bridging).
   */
  translateMessage(
    message: ForgeMessage,
    targetProtocol: 'a2a' | 'mcp',
  ): ForgeMessage;
}
```

#### 2.7.2 Schema Mapping Rules

| MCP Schema Feature | A2A Equivalent | Notes |
|-------------------|----------------|-------|
| `inputSchema.properties` | `capability.inputSchema.properties` | Direct mapping |
| `inputSchema.required` | `capability.inputSchema.required` | Direct mapping |
| Tool `name` | Capability `name` | Add prefix if configured |
| Tool `description` | Capability `description` | Direct mapping |
| `type: 'array'` items | JSON Schema array | Compatible |
| Nested `type: 'object'` | Nested JSON Schema object | Compatible |
| MCP `content[]` result | A2A `parts[]` message | `text` -> `text`, `image` -> `file`, `resource` -> `data` |

---

### F8: Message Serialization (P1, 4h)

> **Owner:** `@dzipagent/core` (`core/src/protocol/serialization.ts`)
> **Depends on:** F1

#### 2.8.1 Interface

```typescript
// core/src/protocol/serialization.ts

import type { ForgeMessage } from './message.js';

// ---------------------------------------------------------------------------
// Serialization format
// ---------------------------------------------------------------------------

export type SerializationFormat = 'json' | 'msgpack';

// ---------------------------------------------------------------------------
// Serializer interface
// ---------------------------------------------------------------------------

export interface ForgeMessageSerializer {
  readonly format: SerializationFormat;

  /**
   * Serialize a ForgeMessage to bytes.
   * Returns a Uint8Array suitable for transport.
   */
  serialize(message: ForgeMessage): Uint8Array;

  /**
   * Deserialize bytes back to a ForgeMessage.
   * Throws ForgeError with code 'SERIALIZATION_FAILED' on invalid input.
   */
  deserialize(data: Uint8Array): ForgeMessage;

  /**
   * Content-Type header value for HTTP transports.
   */
  contentType(): string;
}

// ---------------------------------------------------------------------------
// JSON serializer (default)
// ---------------------------------------------------------------------------

/**
 * JSON serializer. Default for all transports.
 * Content-Type: application/json
 */
export class JsonMessageSerializer implements ForgeMessageSerializer {
  readonly format: SerializationFormat = 'json';

  serialize(message: ForgeMessage): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(message));
  }

  deserialize(data: Uint8Array): ForgeMessage {
    const text = new TextDecoder().decode(data);
    return JSON.parse(text) as ForgeMessage;
    // Caller should validate with forgeMessageSchema if needed
  }

  contentType(): string {
    return 'application/json';
  }
}

// ---------------------------------------------------------------------------
// MessagePack serializer (optional, for high-throughput)
// ---------------------------------------------------------------------------

/**
 * MessagePack serializer for high-throughput scenarios.
 * Requires `@msgpack/msgpack` peer dependency.
 *
 * Benefits over JSON:
 * - ~30% smaller payload for typical ForgeMessages
 * - Faster serialization/deserialization
 * - Native binary support (no base64 encoding needed)
 *
 * Content-Type: application/x-msgpack
 */
export class MsgpackMessageSerializer implements ForgeMessageSerializer {
  readonly format: SerializationFormat = 'msgpack';
  private encoder: { encode: (obj: unknown) => Uint8Array } | null = null;
  private decoder: { decode: (data: Uint8Array) => unknown } | null = null;

  private async ensureLoaded(): Promise<void> {
    if (this.encoder) return;
    const msgpack = await import('@msgpack/msgpack');
    this.encoder = { encode: msgpack.encode };
    this.decoder = { decode: msgpack.decode };
  }

  serialize(message: ForgeMessage): Uint8Array {
    if (!this.encoder) {
      throw new Error('MsgpackMessageSerializer not initialized. Call ensureLoaded() first.');
    }
    return this.encoder.encode(message);
  }

  deserialize(data: Uint8Array): ForgeMessage {
    if (!this.decoder) {
      throw new Error('MsgpackMessageSerializer not initialized. Call ensureLoaded() first.');
    }
    return this.decoder.decode(data) as ForgeMessage;
  }

  contentType(): string {
    return 'application/x-msgpack';
  }
}

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/**
 * ForgeMessage schema version. Embedded in serialized payloads
 * for forward/backward compatibility.
 *
 * Versioning rules:
 * - MAJOR bump: breaking changes to required fields
 * - MINOR bump: new optional fields added
 * - Receivers should accept messages with minor version >= their own
 * - Receivers should reject messages with major version != their own
 */
export const DZIP_MESSAGE_SCHEMA_VERSION = '1.0';

export interface VersionedPayload {
  /** Schema version string (semver major.minor) */
  v: string;
  /** The serialized ForgeMessage */
  d: Uint8Array;
}

/**
 * Wrap a serialized message with version metadata.
 */
export function wrapWithVersion(data: Uint8Array): VersionedPayload {
  return { v: DZIP_MESSAGE_SCHEMA_VERSION, d: data };
}

/**
 * Check if a versioned payload is compatible with this runtime.
 */
export function isVersionCompatible(payload: VersionedPayload): boolean {
  const [remoteMajor] = payload.v.split('.');
  const [localMajor] = DZIP_MESSAGE_SCHEMA_VERSION.split('.');
  return remoteMajor === localMajor;
}
```

---

### F9: gRPC Transport (P2, 12h)

> **Owner:** `@dzipagent/a2a` (`a2a/src/grpc/`)
> **Depends on:** F1, F2, F8

gRPC adapter for high-performance A2A communication. This is a P2 feature for production deployments where HTTP+SSE latency is insufficient.

#### 2.9.1 Proto Definition

```protobuf
// a2a/proto/forge_message.proto

syntax = "proto3";

package forgeagent.protocol.v1;

service ForgeProtocol {
  // Unary: send a message, receive a response
  rpc Send(ForgeMessageProto) returns (ForgeMessageProto);

  // Server-streaming: send a request, receive stream of responses
  rpc Stream(ForgeMessageProto) returns (stream ForgeMessageProto);

  // Bidirectional streaming: full-duplex communication
  rpc Channel(stream ForgeMessageProto) returns (stream ForgeMessageProto);

  // Health check
  rpc HealthCheck(HealthRequest) returns (HealthResponse);
}

message ForgeMessageProto {
  string id = 1;
  string type = 2;            // request, response, notification, stream_chunk, stream_end, error
  string from = 3;
  string to = 4;
  string protocol = 5;
  int64 timestamp = 6;
  optional string correlation_id = 7;
  optional string parent_id = 8;
  bytes payload = 9;          // JSON or MessagePack encoded ForgePayload
  string payload_format = 10; // "json" or "msgpack"
  ForgeMetadataProto metadata = 11;
}

message ForgeMetadataProto {
  optional string trace_id = 1;
  optional string span_id = 2;
  optional string parent_span_id = 3;
  optional string priority = 4;
  optional int64 ttl_ms = 5;
  optional string delegation_token = 6;
  optional BudgetProto budget = 7;
  map<string, string> extensions = 8;
}

message BudgetProto {
  optional int32 max_tokens = 1;
  optional double max_cost_cents = 2;
  optional int32 max_iterations = 3;
}

message HealthRequest {}

message HealthResponse {
  string state = 1;
  int64 last_activity_ms = 2;
  int32 pending_count = 3;
}
```

#### 2.9.2 Adapter Interface

```typescript
// a2a/src/grpc/grpc-adapter.ts

import type {
  ProtocolAdapter,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
} from '@dzipagent/core';
import type { ForgeMessage, ForgeProtocol } from '@dzipagent/core';

export interface GrpcAdapterConfig {
  /** Target address (host:port) */
  target: string;
  /** TLS credentials. If omitted, insecure channel is used. */
  tls?: {
    rootCerts?: Buffer;
    privateKey?: Buffer;
    certChain?: Buffer;
  };
  /** Connection pool size (default: 4) */
  poolSize?: number;
  /** Keepalive ping interval in ms (default: 30_000) */
  keepaliveIntervalMs?: number;
  /** Maximum message size in bytes (default: 4MB) */
  maxMessageSizeBytes?: number;
}

/**
 * gRPC ProtocolAdapter for high-performance A2A communication.
 *
 * Features:
 * - Connection pooling for concurrent requests
 * - Bidirectional streaming support
 * - Automatic reconnection with backoff
 * - TLS with mutual authentication
 *
 * Peer dependency: @grpc/grpc-js
 */
export class GrpcAdapter implements ProtocolAdapter {
  readonly adapterId: string;
  readonly protocols: readonly ForgeProtocol[] = ['grpc'] as const;

  // Implementation deferred to P2.
  // The adapter will:
  // 1. Create a gRPC client from the proto definition
  // 2. Manage a connection pool of `poolSize` channels
  // 3. Round-robin requests across the pool
  // 4. Implement automatic reconnection with exponential backoff
  // 5. Serialize ForgeMessage payloads using the configured serializer (JSON or msgpack)

  constructor(private readonly config: GrpcAdapterConfig) {
    this.adapterId = `grpc-${config.target}`;
  }

  get state(): AdapterState { return 'disconnected'; }
  async connect(): Promise<boolean> { return false; /* P2 */ }
  async disconnect(): Promise<void> { /* P2 */ }
  isConnected(): boolean { return false; }
  healthCheck(): AdapterHealthStatus {
    return { state: 'disconnected', lastActivityMs: 0, pendingCount: 0 };
  }
  async send(_message: ForgeMessage, _options?: SendOptions): Promise<ForgeMessage | null> { return null; }
  async *stream(_message: ForgeMessage, _options?: SendOptions): AsyncGenerator<ForgeMessage> { /* P2 */ }
  subscribe(_targetPattern: string, _handler: MessageHandler): Subscription {
    return { unsubscribe: () => {} };
  }
}
```

---

### F10: Protocol Negotiation (P2, 8h)

> **Owner:** `@dzipagent/core` (`core/src/protocol/negotiation.ts`)
> **Depends on:** F2

Protocol negotiation enables two DzipAgent instances to agree on capabilities before exchanging messages. This is essential for forward compatibility as new features are added.

#### 2.10.1 Interface

```typescript
// core/src/protocol/negotiation.ts

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/**
 * Features that can be negotiated between two DzipAgent instances.
 * Both sides declare what they support; communication uses the intersection.
 */
export interface ProtocolCapabilities {
  /** Supported ForgeMessage schema versions (e.g., ['1.0']) */
  schemaVersions: string[];
  /** Supported serialization formats */
  serialization: Array<'json' | 'msgpack'>;
  /** Whether streaming is supported */
  streaming: boolean;
  /** Whether bidirectional streaming is supported (gRPC only) */
  bidirectionalStreaming: boolean;
  /** Supported payload content types */
  payloadTypes: Array<'text' | 'json' | 'tool_call' | 'tool_result' | 'task' | 'binary' | 'error'>;
  /** Whether budget propagation is understood */
  budgetAware: boolean;
  /** Whether W3C Trace Context headers are supported */
  traceContext: boolean;
  /** Maximum message size in bytes (0 = unlimited) */
  maxMessageSize: number;
  /** Extension capabilities (for plugins) */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Negotiation result
// ---------------------------------------------------------------------------

export interface NegotiatedCapabilities {
  /** The agreed-upon schema version (highest common) */
  schemaVersion: string;
  /** The agreed-upon serialization format (prefer msgpack if both support it) */
  serialization: 'json' | 'msgpack';
  /** Whether streaming is available */
  streaming: boolean;
  /** Whether bidirectional streaming is available */
  bidirectionalStreaming: boolean;
  /** Available payload types (intersection) */
  payloadTypes: string[];
  /** Whether budget propagation is available */
  budgetAware: boolean;
  /** Whether tracing is available */
  traceContext: boolean;
  /** Effective max message size (minimum of both sides) */
  maxMessageSize: number;
}

// ---------------------------------------------------------------------------
// Negotiation protocol
// ---------------------------------------------------------------------------

/**
 * Protocol negotiation handshake.
 *
 * Flow:
 * 1. Client sends its capabilities
 * 2. Server responds with its capabilities
 * 3. Both sides compute the intersection (NegotiatedCapabilities)
 * 4. Communication proceeds using negotiated settings
 *
 * If no common ground exists (e.g., no shared schema version),
 * negotiation fails and the adapter reports PROTOCOL_NEGOTIATION_FAILED.
 */
export interface ProtocolNegotiator {
  /** Get this instance's capabilities. */
  getLocalCapabilities(): ProtocolCapabilities;

  /**
   * Perform the negotiation handshake with a remote peer.
   * Returns the negotiated capabilities, or null if negotiation failed.
   */
  negotiate(remoteCapabilities: ProtocolCapabilities): NegotiatedCapabilities | null;
}

/**
 * Compute the intersection of two capability sets.
 * Returns null if no viable common ground exists.
 */
export function negotiateCapabilities(
  local: ProtocolCapabilities,
  remote: ProtocolCapabilities,
): NegotiatedCapabilities | null {
  // Schema version: find highest common major.minor
  const commonVersions = local.schemaVersions.filter(v => remote.schemaVersions.includes(v));
  if (commonVersions.length === 0) return null;

  const schemaVersion = commonVersions.sort().reverse()[0]!;

  // Serialization: prefer msgpack, fall back to json
  const commonSerialization = local.serialization.filter(s => remote.serialization.includes(s));
  if (commonSerialization.length === 0) return null;

  const serialization = commonSerialization.includes('msgpack') ? 'msgpack' as const : 'json' as const;

  // Payload types: intersection
  const payloadTypes = local.payloadTypes.filter(pt => remote.payloadTypes.includes(pt));
  if (payloadTypes.length === 0) return null;

  return {
    schemaVersion,
    serialization,
    streaming: local.streaming && remote.streaming,
    bidirectionalStreaming: local.bidirectionalStreaming && remote.bidirectionalStreaming,
    payloadTypes,
    budgetAware: local.budgetAware && remote.budgetAware,
    traceContext: local.traceContext && remote.traceContext,
    maxMessageSize: Math.min(
      local.maxMessageSize || Infinity,
      remote.maxMessageSize || Infinity,
    ),
  };
}
```

---

## 3. Data Flow Diagrams

### 3.1 DzipAgent A Sending a Task to DzipAgent B via A2A

```
  DzipAgent A (local process)                    DzipAgent B (remote, HTTP)
  ===========================                     ============================

  1. agent.generate() calls
     orchestrator.delegateTo('code-reviewer', task)
         |
  2. Orchestrator creates ForgeMessage:
     {
       type: 'request',
       from: 'forge://local/planner',
       to: 'a2a://code-reviewer',        <-- URI determines adapter
       protocol: 'a2a',
       payload: { contentType: 'task', taskId: 't1', state: 'submitted', input: {...} },
       metadata: { traceId: '...', budget: { maxTokens: 10000 } },
     }
         |
  3. ProtocolRouter.send(message)
         |
  4. Router resolves adapter:
     URI 'a2a://' -> A2AClientAdapter
         |
  5. A2AClientAdapter.send():
     a. Looks up base URL: config.agents['code-reviewer'] -> 'http://reviewer:8080'
     b. Translates ForgeMessage -> A2A JSON-RPC:
        POST http://reviewer:8080/a2a
        { "jsonrpc": "2.0", "method": "tasks/send", "params": {...} }
     c. Adds auth headers (Bearer token)
     d. Sends with retry (exp backoff on 429/502/503/504)
         |                                          |
         +--- HTTP POST --------------------------->+
                                                    |
                                               6. Hono A2A route receives request
                                               7. TaskManager creates task, invokes agent
                                               8. DzipAgent B processes task
                                               9. Returns JSON-RPC response
                                                    |
         +<-- HTTP 200 JSON-RPC response -----------+
         |
  10. A2AClientAdapter translates response -> ForgeMessage:
      {
        type: 'response',
        from: 'a2a://code-reviewer',
        to: 'forge://local/planner',
        correlationId: original.id,
        payload: { contentType: 'task', taskId: 't1', state: 'completed', output: {...} },
      }
         |
  11. Router returns ForgeMessage to orchestrator
         |
  12. Orchestrator merges result into agent state
```

### 3.2 MCP Tool Call Flow Through ProtocolAdapter

```
  DzipAgent tool loop                MCPClient (existing)          MCP Server
  =====================               ================             ===========

  1. LLM emits tool_call:
     { name: 'mcp_fs_read_file', args: { path: '/src/index.ts' } }
         |
  2. Tool loop finds the tool is an MCP-bridged tool
     (created by mcpToolToLangChain in mcp-tool-bridge.ts)
         |
  3. Tool handler calls mcpClient.invokeTool('read_file', args)
         |
     NOTE: MCP tool calls do NOT go through ProtocolAdapter
     by default. MCPClient has its own transport layer.
     However, if observability or budget tracking is needed,
     the call CAN be wrapped in a ForgeMessage:
         |
  4. (Optional) Create ForgeMessage for tracing:
     {
       type: 'request',
       from: 'forge://local/coder',
       to: 'mcp://filesystem/read_file',
       protocol: 'mcp',
       payload: { contentType: 'tool_call', toolName: 'read_file', arguments: { path: '...' } },
       metadata: { traceId: '...' },
     }
         |
  5. MCPClient sends JSON-RPC to MCP server:
     POST /tools/call                            |
     { "jsonrpc": "2.0", "method": "tools/call", +->  MCP Server processes
       "params": { "name": "read_file", ... } }      and returns result
         |                                       |
     <-- JSON-RPC response ----------------------+
         |
  6. MCPClient returns MCPToolResult
         |
  7. mcp-tool-bridge converts to string
         |
  8. Tool loop injects ToolMessage into conversation
```

### 3.3 Protocol Bridge: MCP Tool Exposed as A2A Capability

```
  Remote A2A Client              DzipAgent Server              Local MCP Server
  =================              =================              ================

  1. Client fetches agent card:
     GET /.well-known/agent.json
         |                            |
         +--------------------------->+
                                      |
  2. Agent card includes bridged MCP tools as capabilities:
     {
       "capabilities": [
         { "name": "read_file", "description": "Read a file...",
           "inputSchema": { ... } },   <-- translated from MCP tool schema
       ]
     }
                                      |
         +<---------------------------+
         |
  3. Client sends A2A task targeting 'read_file':
     POST /a2a
     { "method": "tasks/send", "params": { "input": { "path": "/src/..." } } }
         |                            |
         +--------------------------->+
                                      |
  4. ProtocolBridge detects this is a bridged MCP tool:
     a. Translates A2A task input -> MCP tool call args
     b. Calls mcpClient.invokeTool('read_file', { path: '...' })
                                      |                            |
                                      +--------------------------->+
                                                                   |
                                      +<-- MCP JSON-RPC response --+
                                      |
  5. ProtocolBridge translates MCP result -> A2A task output:
     a. MCPToolResult.content[].text -> A2AMessage.parts[].text
     b. Sets task state to 'completed'
                                      |
         +<-- A2A JSON-RPC response --+
         |
  6. Client receives A2A task result
```

### 3.4 Streaming Message Flow (A2A SSE)

```
  DzipAgent A                   A2AClientAdapter              DzipAgent B Server
  ============                   ================              ===================

  1. Agent A calls:
     for await (const chunk of router.stream(message)) { ... }
         |
  2. A2AClientAdapter.stream():
     POST /a2a  (Accept: text/event-stream)
     { "method": "tasks/sendSubscribe", "params": {...} }
         |                            |
         +--- HTTP POST ------------->+
                                      |
                                 3. Server starts SSE response
                                 4. Agent B begins processing
                                      |
         +<-- data: {"state":"working", "output":{"parts":[...]}} ---+
         |                                                            |
  5. Adapter parses SSE, yields ForgeMessage:                         |
     { type: 'stream_chunk', payload: { contentType: 'task', ... } } |
         |                                                            |
  6. Agent A receives chunk, continues loop                           |
         |                                                            |
         +<-- data: {"state":"working", "output":{"parts":[...]}} ---+
         |                                                            |
  7. Another chunk...                                                 |
         |                                                            |
         +<-- data: {"state":"completed", "output":{...}} -----------+
         |
  8. Adapter yields final ForgeMessage:
     { type: 'stream_end', payload: { contentType: 'task', state: 'completed', ... } }
         |
  9. AsyncGenerator completes, Agent A has full result
```

---

## 4. File Structure

### 4.1 New Package: `@dzipagent/a2a`

```
packages/forgeagent-a2a/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                           # Public API barrel export
    client/
      a2a-client-adapter.ts           # F4: ProtocolAdapter for A2A client
      a2a-http-transport.ts           # Low-level HTTP transport helpers
      a2a-types.ts                    # F4: A2A protocol type definitions
      agent-card-cache.ts             # F4: Agent card caching with TTL
    server/
      a2a-server-adapter.ts           # Server-side adapter (upgraded from @dzipagent/server)
      task-manager.ts                 # Task lifecycle manager (upgraded from server/a2a)
    bridge/
      protocol-bridge.ts              # F7: MCP <-> A2A translation
      schema-mapper.ts                # F7: JSON Schema compatibility checking
    grpc/
      grpc-adapter.ts                 # F9: gRPC ProtocolAdapter (stub for P2)
      forge_message.proto             # F9: Proto definitions
    __tests__/
      a2a-client-adapter.test.ts
      agent-card-cache.test.ts
      protocol-bridge.test.ts
      mock-a2a-server.ts              # Test fixture: minimal Hono A2A server
```

**package.json dependencies:**

```json
{
  "name": "@dzipagent/a2a",
  "version": "0.1.0",
  "type": "module",
  "peerDependencies": {
    "@dzipagent/core": "^0.1.0"
  },
  "devDependencies": {
    "hono": "^4.0.0"
  },
  "optionalDependencies": {
    "@grpc/grpc-js": "^1.10.0",
    "@grpc/proto-loader": "^0.7.0"
  }
}
```

### 4.2 Extensions to `@dzipagent/core/src/mcp/`

```
packages/forgeagent-core/src/mcp/
  (existing files unchanged)
  mcp-client.ts
  mcp-server.ts
  mcp-tool-bridge.ts
  mcp-types.ts
  deferred-loader.ts
  index.ts

  (new files)
  mcp-resources.ts                     # F5: Resource read/subscribe support
  mcp-sampling.ts                      # F6: Sampling request handler
```

### 4.3 New Directory: `@dzipagent/core/src/protocol/`

```
packages/forgeagent-core/src/protocol/
  index.ts                             # Barrel export
  message.ts                           # F1: ForgeMessage types + Zod schemas + factories
  adapter.ts                           # F2: ProtocolAdapter interface + ProtocolRouter interface
  router.ts                            # F2: DefaultProtocolRouter implementation
  internal-adapter.ts                  # F3: InternalAdapter (wraps EventBus + AgentBus)
  serialization.ts                     # F8: JSON + MessagePack serializers
  negotiation.ts                       # F10: Capability negotiation
```

### 4.4 Server Integration (`@dzipagent/server`)

No new files, but the following existing files are modified:

| File | Change |
|------|--------|
| `server/src/a2a/agent-card.ts` | Update `AgentCard` type to extend `A2AAgentCard` from `@dzipagent/a2a` |
| `server/src/a2a/task-handler.ts` | Delegate to `@dzipagent/a2a/server/task-manager.ts` |
| `server/src/routes/a2a.ts` | Add SSE streaming endpoint (`tasks/sendSubscribe`) |
| `server/src/app.ts` | Register ProtocolRouter, auto-register InternalAdapter |

---

## 5. Integration Points

### 5.1 How ProtocolAdapter Registers in ForgeContainer

DzipAgent does not currently have a DI container. The ProtocolRouter is initialized explicitly and passed to DzipAgent via config. Future ForgeContainer will auto-register adapters from plugins.

```typescript
// Example: Manual setup (current approach)

import { DefaultProtocolRouter, InternalAdapter } from '@dzipagent/core';
import { A2AClientAdapter } from '@dzipagent/a2a';
import { createEventBus, AgentBus } from '@dzipagent/core';

const eventBus = createEventBus();
const agentBus = new AgentBus();
const router = new DefaultProtocolRouter(eventBus);

// Always register the internal adapter
const internalAdapter = new InternalAdapter(eventBus, agentBus);
await internalAdapter.connect();
router.registerAdapter(internalAdapter);

// Optionally register A2A adapter
const a2aAdapter = new A2AClientAdapter({
  agents: { 'code-reviewer': 'http://reviewer:8080' },
  auth: { type: 'bearer', token: process.env.A2A_TOKEN! },
});
await a2aAdapter.connect();
router.registerAdapter(a2aAdapter);
```

```typescript
// Example: Plugin-based setup (future DzipPlugin approach)

import { DzipAgent } from '@dzipagent/agent';
import { a2aPlugin } from '@dzipagent/a2a';

const agent = new DzipAgent({
  id: 'planner',
  instructions: '...',
  model: 'reasoning',
  plugins: [
    a2aPlugin({
      agents: { 'code-reviewer': 'http://reviewer:8080' },
      auth: { type: 'bearer', token: process.env.A2A_TOKEN! },
    }),
  ],
});
```

### 5.2 How DzipAgent.generate() Uses ProtocolAdapter for Sub-Agent Calls

The orchestrator patterns (`AgentOrchestrator.supervisor`, `.sequential`, etc.) currently call `agent.generate()` directly. With ProtocolAdapter, they gain the ability to delegate to remote agents transparently.

```typescript
// orchestration/orchestrator.ts — upgraded to use ProtocolRouter

import type { ProtocolRouter } from '@dzipagent/core';

export class AgentOrchestrator {
  constructor(private router?: ProtocolRouter) {}

  /**
   * Delegate a task to an agent by URI.
   * If the URI is local (forge://local/*), routes through InternalAdapter.
   * If the URI is remote (a2a://*, grpc://*), routes through the appropriate adapter.
   */
  async delegateTo(
    agentUri: string,
    task: string,
    options?: { budget?: { maxTokens?: number; maxCostCents?: number }; parentId?: ForgeMessageId },
  ): Promise<string> {
    if (!this.router) {
      throw new Error('ProtocolRouter not configured. Cannot delegate to remote agents.');
    }

    const message = createForgeMessage({
      type: 'request',
      from: 'forge://local/orchestrator',
      to: agentUri,
      protocol: 'internal', // router will override based on URI
      payload: { contentType: 'text', text: task },
      metadata: {
        budget: options?.budget,
      },
      parentId: options?.parentId,
    });

    const response = await this.router.send(message);
    if (!response) return '[No response from agent]';

    if (response.payload.contentType === 'text') return response.payload.text;
    if (response.payload.contentType === 'task' && response.payload.output) {
      return typeof response.payload.output === 'string'
        ? response.payload.output
        : JSON.stringify(response.payload.output);
    }
    if (response.payload.contentType === 'error') {
      return `[Error: ${response.payload.message}]`;
    }

    return JSON.stringify(response.payload);
  }

  /**
   * Stream results from a remote agent.
   */
  async *streamFrom(
    agentUri: string,
    task: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    if (!this.router) return;

    const message = createForgeMessage({
      type: 'request',
      from: 'forge://local/orchestrator',
      to: agentUri,
      protocol: 'internal',
      payload: { contentType: 'text', text: task },
      metadata: {},
    });

    for await (const chunk of this.router.stream(message, { signal: options?.signal })) {
      if (chunk.payload.contentType === 'text') {
        yield chunk.payload.text;
      } else if (chunk.payload.contentType === 'task' && chunk.payload.output) {
        yield typeof chunk.payload.output === 'string'
          ? chunk.payload.output
          : JSON.stringify(chunk.payload.output);
      }
    }
  }
}
```

### 5.3 How @dzipagent/server Exposes A2A Endpoints

The server already has A2A routes. The upgrade adds:

1. **SSE streaming endpoint** for `tasks/sendSubscribe`
2. **JSON-RPC wire format** (currently uses REST; A2A spec prefers JSON-RPC)
3. **Integration with ProtocolRouter** for routing incoming A2A tasks to local agents

```typescript
// server/src/routes/a2a.ts — additions (not replacement)

// New: JSON-RPC endpoint (A2A spec compliant)
app.post('/a2a', async (c) => {
  const body = await c.req.json<A2AJsonRpcRequest>();

  switch (body.method) {
    case 'tasks/send':
      return handleTaskSend(c, body);

    case 'tasks/sendSubscribe':
      // SSE streaming response
      return streamSSE(c, async (stream) => {
        const task = await taskManager.create(body.params);
        for await (const event of taskManager.executeStreaming(task.id)) {
          await stream.writeSSE({
            data: JSON.stringify(event),
          });
        }
      });

    case 'tasks/get':
      return handleTaskGet(c, body);

    case 'tasks/list':
      return handleTaskList(c, body);

    case 'tasks/cancel':
      return handleTaskCancel(c, body);

    default:
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: `Unknown method: ${body.method}` },
      }, 200);
  }
});
```

---

## 6. Testing Strategy

### 6.1 Mock A2A Server

A lightweight Hono-based mock server for testing A2A client behavior without network dependencies.

```typescript
// a2a/src/__tests__/mock-a2a-server.ts

import { Hono } from 'hono';

export interface MockA2AServerOptions {
  agentCard: {
    name: string;
    capabilities: Array<{ name: string; description: string }>;
  };
  /** Handlers for each capability. Maps capability name -> handler. */
  handlers?: Record<string, (input: unknown) => Promise<unknown>>;
  /** Artificial delay in ms to simulate latency. */
  latencyMs?: number;
  /** If set, the server returns this error for all requests. */
  forceError?: { code: number; message: string };
}

/**
 * Creates a Hono app that implements the A2A protocol for testing.
 *
 * Supports:
 * - Agent card discovery (GET /.well-known/agent.json)
 * - tasks/send (synchronous)
 * - tasks/sendSubscribe (SSE streaming -- sends 3 chunks then completes)
 * - tasks/get
 * - tasks/cancel
 */
export function createMockA2AServer(options: MockA2AServerOptions): Hono {
  const app = new Hono();
  const tasks = new Map<string, { state: string; input: unknown; output?: unknown }>();
  let taskCounter = 0;

  app.get('/.well-known/agent.json', (c) => {
    return c.json({
      name: options.agentCard.name,
      description: `Mock ${options.agentCard.name}`,
      url: 'http://localhost:0',
      version: '1.0.0',
      capabilities: options.agentCard.capabilities.map(cap => ({
        ...cap,
        inputSchema: { type: 'object', properties: {} },
      })),
    });
  });

  app.post('/a2a', async (c) => {
    if (options.latencyMs) {
      await new Promise(resolve => setTimeout(resolve, options.latencyMs));
    }

    if (options.forceError) {
      return c.json({
        jsonrpc: '2.0',
        id: 1,
        error: options.forceError,
      });
    }

    const body = await c.req.json<{ method: string; params: Record<string, unknown>; id: number }>();

    switch (body.method) {
      case 'tasks/send': {
        taskCounter++;
        const taskId = `mock-task-${taskCounter}`;
        const handler = options.handlers?.[String(body.params['agentName'] ?? '')];
        const output = handler ? await handler(body.params['input']) : { text: 'mock response' };
        tasks.set(taskId, { state: 'completed', input: body.params['input'], output });
        return c.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { id: taskId, state: 'completed', output, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        });
      }
      // ... other methods
      default:
        return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Not found' } });
    }
  });

  return app;
}
```

### 6.2 Test Categories

| Category | What | Tools | Priority |
|----------|------|-------|----------|
| **Unit: ForgeMessage** | Validation, factory helpers, TTL checking, schema coverage | Vitest | P0 |
| **Unit: Serialization** | JSON round-trip, msgpack round-trip, version compat | Vitest | P1 |
| **Unit: InternalAdapter** | Send/receive, correlation, timeout, stream | Vitest | P0 |
| **Unit: A2AClientAdapter** | Card fetching, retry logic, error handling | Vitest + mock-a2a-server | P0 |
| **Unit: ProtocolBridge** | MCP->A2A mapping, A2A->MCP mapping, schema compat | Vitest | P1 |
| **Unit: Negotiation** | Capability intersection, version mismatch, edge cases | Vitest | P2 |
| **Integration: A2A round-trip** | Full send/receive through A2A adapter + mock server | Vitest + Hono testClient | P0 |
| **Integration: Streaming** | SSE stream through A2A adapter | Vitest + Hono testClient | P1 |
| **Integration: Router** | Multi-adapter routing, fallback, error propagation | Vitest | P1 |
| **Protocol compliance** | Validate against A2A spec test vectors (when available) | Vitest | P1 |
| **Load: Streaming** | 1000 concurrent SSE streams, measure memory/latency | k6 or autocannon | P2 |
| **Load: Message throughput** | 10K messages/sec through InternalAdapter | Vitest bench | P2 |

### 6.3 LLM Recorder Integration

For tests that involve DzipAgent processing A2A tasks, use the LLM recorder from `@dzipagent/test-utils` (planned) to capture and replay LLM responses:

```typescript
// Example test with LLM recording
import { createLLMRecorder } from '@dzipagent/test-utils';
import { A2AClientAdapter } from '@dzipagent/a2a';

describe('A2A task delegation', () => {
  it('should delegate a code review task via A2A', async () => {
    const recorder = createLLMRecorder('a2a-code-review');

    // First run: records LLM responses
    // Subsequent runs: replays from fixtures
    const model = recorder.wrap(realModel);

    const agent = new DzipAgent({ id: 'reviewer', model, ... });
    // ... test A2A flow
  });
});
```

---

## 7. Migration from Current State

### 7.1 Backward Compatibility

All changes are **additive**. Existing code continues to work without modification:

| Existing API | Status | Migration |
|-------------|--------|-----------|
| `DzipEventBus` | Unchanged | Continue using for internal events |
| `AgentBus` | Unchanged | InternalAdapter layers on top, does not modify |
| `MCPClient` | Unchanged | New features (Resources, Sampling) are opt-in extensions |
| `MCPToolBridge` | Unchanged | Still the primary MCP->LangChain bridge |
| `A2ATaskStore` (server) | Unchanged | `@dzipagent/a2a` TaskManager delegates to it |
| `createA2ARoutes` (server) | Unchanged | New JSON-RPC endpoint is additive |
| `AgentOrchestrator` | Extended | New `delegateTo()` method; existing `sequential`/`parallel`/`supervisor`/`debate` unchanged |

### 7.2 New Exports from `@dzipagent/core`

```typescript
// core/src/index.ts — additions

// Protocol layer
export type {
  ForgeMessage,
  ForgeMessageId,
  ForgeMessageType,
  ForgeProtocol,
  ForgePayload,
  ForgeTextPayload,
  ForgeJsonPayload,
  ForgeToolCallPayload,
  ForgeToolResultPayload,
  ForgeTaskPayload,
  ForgeBinaryPayload,
  ForgeErrorPayload,
  ForgeMessageMetadata,
} from './protocol/message.js';

export {
  createMessageId,
  createForgeMessage,
  createResponse,
  createErrorResponse,
  validateForgeMessage,
  isMessageAlive,
  forgeMessageSchema,
} from './protocol/message.js';

export type {
  ProtocolAdapter,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
  ProtocolRouter,
  ProtocolErrorCode,
} from './protocol/adapter.js';

export { DefaultProtocolRouter } from './protocol/router.js';
export { InternalAdapter } from './protocol/internal-adapter.js';

export type {
  ForgeMessageSerializer,
  SerializationFormat,
} from './protocol/serialization.js';

export {
  JsonMessageSerializer,
  MsgpackMessageSerializer,
  DZIP_MESSAGE_SCHEMA_VERSION,
} from './protocol/serialization.js';

export type {
  ProtocolCapabilities,
  NegotiatedCapabilities,
  ProtocolNegotiator,
} from './protocol/negotiation.js';

export { negotiateCapabilities } from './protocol/negotiation.js';

// MCP extensions
export type { MCPResourceManager, MCPResource, MCPResourceContent } from './mcp/mcp-resources.js';
export type { MCPSamplingHandler, MCPSamplingRequest, MCPSamplingResponse, MCPSamplingPolicy } from './mcp/mcp-sampling.js';
```

### 7.3 New DzipEvent Types

Add to `core/src/events/event-types.ts`:

```typescript
// Protocol events (add to DzipEvent union)
| { type: 'protocol:adapter_registered'; adapterId: string; protocols: string[] }
| { type: 'protocol:adapter_removed'; adapterId: string }
| { type: 'protocol:send_failed'; adapterId: string; targetUri: string; errorCode: string }
| { type: 'protocol:message_sent'; adapterId: string; messageId: string; targetUri: string }
| { type: 'protocol:message_received'; adapterId: string; messageId: string; fromUri: string }
| { type: 'protocol:negotiation_completed'; adapterId: string; peerUri: string }
| { type: 'protocol:negotiation_failed'; adapterId: string; peerUri: string; reason: string }
```

### 7.4 New ForgeError Codes

Add to `core/src/errors/error-codes.ts`:

```typescript
// Protocol errors
| 'ADAPTER_NOT_FOUND'
| 'ADAPTER_SEND_FAILED'
| 'ADAPTER_TIMEOUT'
| 'ADAPTER_DISCONNECTED'
| 'PROTOCOL_NEGOTIATION_FAILED'
| 'MESSAGE_EXPIRED'
| 'MESSAGE_VALIDATION_FAILED'
| 'SERIALIZATION_FAILED'
// A2A errors
| 'A2A_TASK_NOT_FOUND'
| 'A2A_TASK_FAILED'
| 'A2A_CARD_FETCH_FAILED'
// MCP extensions
| 'MCP_RESOURCE_NOT_FOUND'
| 'MCP_SAMPLING_REJECTED'
| 'MCP_SAMPLING_BUDGET_EXCEEDED'
```

---

## Summary: Effort and Priority Matrix

| ID | Feature | Priority | Est. Hours | Package | Dependencies |
|----|---------|----------|-----------|---------|--------------|
| F1 | ForgeMessage Envelope | P0 | 4h | `core` | 01-Identity (soft) |
| F2 | ProtocolAdapter + Router | P0 | 4h | `core` | F1 |
| F3 | InternalAdapter | P0 | (in F2) | `core` | F1, F2 |
| F4 | A2A Client Adapter | P0 | 12h | `a2a` | F1, F2 |
| F5 | MCP Resources | P1 | 8h | `core` | MCPClient |
| F6 | MCP Sampling | P1 | 8h | `core` | ModelRegistry |
| F7 | Protocol Bridge | P1 | 8h | `a2a` | F1, F2, F4 |
| F8 | Message Serialization | P1 | 4h | `core` | F1 |
| F9 | gRPC Transport | P2 | 12h | `a2a` | F1, F2, F8 |
| F10 | Protocol Negotiation | P2 | 8h | `core` | F2 |
| | **Total** | | **68h** | | |

### Implementation Order

```
Week 1 (P0 — 20h):
  F1: ForgeMessage ──> F2: ProtocolAdapter + F3: InternalAdapter ──> F4: A2A Client

Week 2-3 (P1 — 28h):
  F5: MCP Resources (parallel with F6)
  F6: MCP Sampling (parallel with F5)
  F7: Protocol Bridge (after F4)
  F8: Serialization (after F1)

Week 4+ (P2 — 20h):
  F9: gRPC Transport
  F10: Protocol Negotiation
```
