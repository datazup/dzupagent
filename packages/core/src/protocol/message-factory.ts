/**
 * Factory helpers for creating and validating ForgeMessage envelopes.
 */
import { randomUUID } from 'node:crypto'

import type { ForgeErrorCode } from '../errors/error-codes.js'
import { ForgeMessageSchema } from './message-schemas.js'
import type {
  ForgeMessage,
  ForgeMessageId,
  ForgeMessageMetadata,
  ForgeMessageType,
  ForgePayload,
  ForgeProtocol,
} from './message-types.js'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a UUIDv7-style message ID.
 *
 * Uses a timestamp prefix (milliseconds in hex) concatenated with a random
 * UUID suffix to approximate UUIDv7 ordering without requiring a full
 * UUIDv7 library.
 */
export function createMessageId(): ForgeMessageId {
  const timestampHex = Date.now().toString(16).padStart(12, '0')
  const randomPart = randomUUID().replace(/-/g, '').slice(0, 20)
  return `${timestampHex}-${randomPart}` as ForgeMessageId
}

// ---------------------------------------------------------------------------
// Message creation
// ---------------------------------------------------------------------------

/** Parameters for creating a new ForgeMessage. */
export interface CreateMessageParams {
  type: ForgeMessageType
  from: string
  to: string
  protocol?: ForgeProtocol
  payload: ForgePayload
  metadata?: Partial<ForgeMessageMetadata>
  correlationId?: string
  parentId?: ForgeMessageId
}

/**
 * Create a new ForgeMessage with sensible defaults.
 *
 * - Generates a unique `id` via `createMessageId()`
 * - Defaults `protocol` to `'internal'`
 * - Sets `timestamp` to current ISO time
 * - Spreads provided `metadata` over an empty base
 */
export function createForgeMessage(params: CreateMessageParams): ForgeMessage {
  const {
    type,
    from,
    to,
    protocol = 'internal',
    payload,
    metadata = {},
    correlationId,
    parentId,
  } = params

  const message: ForgeMessage = {
    id: createMessageId(),
    type,
    from,
    to,
    protocol,
    timestamp: new Date().toISOString(),
    payload,
    metadata: { ...metadata },
  }

  if (correlationId !== undefined) {
    message.correlationId = correlationId
  }
  if (parentId !== undefined) {
    message.parentId = parentId
  }

  return message
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Create a response to an existing message.
 *
 * - Swaps `from` and `to`
 * - Sets `correlationId` to the original message's `id`
 * - Preserves `protocol`
 */
export function createResponse(
  original: ForgeMessage,
  payload: ForgePayload,
  metadata?: Partial<ForgeMessageMetadata>,
): ForgeMessage {
  return createForgeMessage({
    type: 'response',
    from: original.to,
    to: original.from,
    protocol: original.protocol,
    payload,
    metadata,
    correlationId: original.id,
  })
}

/**
 * Create an error response to an existing message.
 *
 * Convenience wrapper that builds an error payload and calls `createResponse`.
 */
export function createErrorResponse(
  original: ForgeMessage,
  code: ForgeErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ForgeMessage {
  return createForgeMessage({
    type: 'error',
    from: original.to,
    to: original.from,
    protocol: original.protocol,
    payload: { type: 'error', code, message, details },
    correlationId: original.id,
  })
}

// ---------------------------------------------------------------------------
// TTL check
// ---------------------------------------------------------------------------

/**
 * Check if a message is still alive (not expired by TTL).
 *
 * Returns `true` if:
 * - The message has no `ttlMs` in metadata (never expires), or
 * - The current time is within `ttlMs` of the message timestamp
 */
export function isMessageAlive(message: ForgeMessage): boolean {
  const ttl = message.metadata.ttlMs
  if (typeof ttl !== 'number') {
    return true
  }
  const sentAt = new Date(message.timestamp).getTime()
  return Date.now() - sentAt < ttl
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Discriminated result from validateForgeMessage. */
export type ValidationResult =
  | { success: true; data: ForgeMessage }
  | { success: false; errors: string[] }

/**
 * Validate an unknown value as a ForgeMessage.
 *
 * Returns a discriminated result — never throws.
 */
export function validateForgeMessage(data: unknown): ValidationResult {
  const result = ForgeMessageSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data as ForgeMessage }
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  )
  return { success: false, errors }
}
