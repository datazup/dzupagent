/**
 * TraceSerializer — serialize and deserialize captured traces to/from
 * various formats (JSON, compact JSON, binary).
 *
 * Supports trace sharing with secret sanitization.
 *
 * @module replay/trace-serializer
 */

import { gzipSync, gunzipSync } from 'node:zlib'
import type {
  CapturedTrace,
  SerializeOptions,
  SerializationFormat,
} from './replay-types.js'

// ---------------------------------------------------------------------------
// Default sensitive field patterns
// ---------------------------------------------------------------------------

const DEFAULT_SENSITIVE_PATTERNS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'credential',
  'private_key',
  'privateKey',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
]

// ---------------------------------------------------------------------------
// TraceSerializer
// ---------------------------------------------------------------------------

/**
 * Serializes and deserializes CapturedTrace objects for storage and sharing.
 *
 * ```ts
 * const serializer = new TraceSerializer()
 *
 * // Save to JSON
 * const json = serializer.serialize(trace, { format: 'json' })
 *
 * // Save to compact binary
 * const binary = serializer.serialize(trace, { format: 'binary' })
 *
 * // Load from JSON
 * const restored = serializer.deserialize(json, 'json')
 *
 * // Share safely (sanitize secrets)
 * const safe = serializer.serialize(trace, { format: 'json', sanitize: true })
 * ```
 */
export class TraceSerializer {
  /**
   * Serialize a trace to the specified format.
   *
   * @param trace - The trace to serialize.
   * @param options - Serialization options.
   * @returns Serialized data as a Buffer.
   */
  serialize(trace: CapturedTrace, options: SerializeOptions): Buffer {
    let processedTrace = trace

    if (options.sanitize) {
      processedTrace = this.sanitize(trace, options.redactFields)
    }

    switch (options.format) {
      case 'json':
        return Buffer.from(JSON.stringify(processedTrace, null, 2), 'utf-8')

      case 'json-compact':
        return Buffer.from(JSON.stringify(processedTrace), 'utf-8')

      case 'binary': {
        const json = JSON.stringify(processedTrace)
        const header = Buffer.alloc(8)
        header.write('FGTRACE', 0, 7, 'ascii') // magic bytes
        header.writeUInt8(1, 7) // version byte
        const compressed = gzipSync(Buffer.from(json, 'utf-8'))
        return Buffer.concat([header, compressed])
      }
    }
  }

  /**
   * Deserialize a trace from the specified format.
   *
   * @param data - Serialized data.
   * @param format - The format to decode. If not specified, auto-detects.
   * @returns The deserialized trace.
   */
  deserialize(data: Buffer, format?: SerializationFormat): CapturedTrace {
    const detectedFormat = format ?? this.detectFormat(data)

    switch (detectedFormat) {
      case 'json':
      case 'json-compact': {
        const json = data.toString('utf-8')
        return this.validateTrace(JSON.parse(json) as unknown)
      }

      case 'binary': {
        // Verify magic bytes
        const magic = data.subarray(0, 7).toString('ascii')
        if (magic !== 'FGTRACE') {
          throw new Error(`Invalid binary trace: bad magic bytes "${magic}"`)
        }
        const version = data.readUInt8(7)
        if (version !== 1) {
          throw new Error(`Unsupported binary trace version: ${version}`)
        }
        const compressed = data.subarray(8)
        const json = gunzipSync(compressed).toString('utf-8')
        return this.validateTrace(JSON.parse(json) as unknown)
      }
    }
  }

  /**
   * Sanitize a trace by redacting sensitive fields from event data.
   * Returns a deep clone with sensitive values replaced by '[REDACTED]'.
   */
  sanitize(
    trace: CapturedTrace,
    additionalRedactFields?: string[],
  ): CapturedTrace {
    const redactPatterns = [
      ...DEFAULT_SENSITIVE_PATTERNS,
      ...(additionalRedactFields ?? []),
    ]

    const sanitized = structuredClone(trace)

    for (const event of sanitized.events) {
      event.data = redactObject(event.data, redactPatterns)
      if (event.stateSnapshot) {
        event.stateSnapshot = redactObject(event.stateSnapshot, redactPatterns)
      }
    }

    if (sanitized.metadata) {
      sanitized.metadata = redactObject(
        sanitized.metadata as Record<string, unknown>,
        redactPatterns,
      )
    }

    return sanitized
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private detectFormat(data: Buffer): SerializationFormat {
    if (data.length >= 7 && data.subarray(0, 7).toString('ascii') === 'FGTRACE') {
      return 'binary'
    }
    // Assume JSON
    return 'json'
  }

  private validateTrace(raw: unknown): CapturedTrace {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid trace: expected object')
    }

    const obj = raw as Record<string, unknown>

    if (obj['schemaVersion'] !== '1.0.0') {
      throw new Error(
        `Unsupported trace schema version: ${String(obj['schemaVersion'])}`,
      )
    }

    if (typeof obj['runId'] !== 'string') {
      throw new Error('Invalid trace: missing runId')
    }

    if (!Array.isArray(obj['events'])) {
      throw new Error('Invalid trace: events must be an array')
    }

    return raw as CapturedTrace
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively redact sensitive fields in an object.
 */
function redactObject(
  obj: Record<string, unknown>,
  patterns: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key, patterns)) {
      result[key] = '[REDACTED]'
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>, patterns)
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return redactObject(item as Record<string, unknown>, patterns)
        }
        return item
      })
    } else {
      result[key] = value
    }
  }

  return result
}

function isSensitiveKey(key: string, patterns: string[]): boolean {
  const lower = key.toLowerCase()
  return patterns.some(p => lower.includes(p.toLowerCase()))
}
