/**
 * Message serialization — encode/decode ForgeMessage to/from Uint8Array.
 *
 * Handles edge cases:
 * - Uint8Array payload data is base64-encoded in JSON
 * - ForgeMessageId branded type is preserved through round-trip
 * - Dates remain as ISO strings (ForgeMessage uses string timestamps)
 */
import { ForgeMessageSchema } from './message-schemas.js'
import type { ForgeMessage } from './message-types.js'
import { ForgeError } from '../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Encoder constants
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Marker used to identify base64-encoded Uint8Arrays in JSON. */
const UINT8_PREFIX = '__uint8:' as const

// ---------------------------------------------------------------------------
// MessageSerializer interface
// ---------------------------------------------------------------------------

export interface MessageSerializer {
  serialize(message: ForgeMessage): Uint8Array
  deserialize(data: Uint8Array): ForgeMessage
  readonly contentType: string
}

// ---------------------------------------------------------------------------
// JSON replacer / reviver
// ---------------------------------------------------------------------------

/**
 * JSON replacer that converts Uint8Array to base64 string with prefix marker.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `${UINT8_PREFIX}${uint8ToBase64(value)}`
  }
  return value
}

/**
 * JSON reviver that converts base64-prefixed strings back to Uint8Array.
 */
function jsonReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(UINT8_PREFIX)) {
    return base64ToUint8(value.slice(UINT8_PREFIX.length))
  }
  return value
}

// ---------------------------------------------------------------------------
// Base64 helpers (no external deps)
// ---------------------------------------------------------------------------

function uint8ToBase64(bytes: Uint8Array): string {
  // Use Buffer in Node.js for efficiency
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  // Fallback for non-Node environments
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// JSONSerializer
// ---------------------------------------------------------------------------

export class JSONSerializer implements MessageSerializer {
  readonly contentType = 'application/json'

  serialize(message: ForgeMessage): Uint8Array {
    const json = JSON.stringify(message, jsonReplacer)
    return encoder.encode(json)
  }

  deserialize(data: Uint8Array): ForgeMessage {
    let raw: unknown
    try {
      const text = decoder.decode(data)
      raw = JSON.parse(text, jsonReviver) as unknown
    } catch (err) {
      throw new ForgeError({
        code: 'SERIALIZATION_FAILED',
        message: `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
        ...(err instanceof Error && { cause: err }),
      })
    }

    const result = ForgeMessageSchema.safeParse(raw)
    if (!result.success) {
      const errors = result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      )
      throw new ForgeError({
        code: 'SERIALIZATION_FAILED',
        message: `Invalid ForgeMessage: ${errors.join('; ')}`,
        recoverable: false,
        context: { validationErrors: errors },
      })
    }

    return result.data as ForgeMessage
  }
}

// ---------------------------------------------------------------------------
// Default instance
// ---------------------------------------------------------------------------

/** Default serializer instance. */
export const defaultSerializer: MessageSerializer = new JSONSerializer()
