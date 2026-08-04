/**
 * IPC serialization helpers for Arrow tables.
 *
 * Wraps apache-arrow's tableToIPC / tableFromIPC with non-fatal error handling
 * and base64 encoding for transport over text-based protocols (e.g. JSON, HTTP).
 */

import { type Table, tableToIPC, tableFromIPC } from 'apache-arrow'

import { MemoryFrameError, logFrameError } from './ipc-errors.js'

// ---------------------------------------------------------------------------
// Serialization options
// ---------------------------------------------------------------------------

/** Options for IPC serialization. */
export interface SerializeOptions {
  /**
   * IPC format: 'stream' or 'file'.
   * Default: 'stream' (more compact, suitable for IPC).
   */
  format?: 'stream' | 'file'
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Serialize an Arrow Table to IPC bytes.
 *
 * ERR-C-23: **throws** `MemoryFrameError('MEMORY_FRAME_SERIALIZE_FAILED')` on
 * failure. It previously returned an empty `Uint8Array`, which callers could
 * not distinguish from a legitimately empty frame — producing self-
 * contradictory responses such as `record_count: 5` alongside `byte_size: 0`.
 */
export function serializeToIPC(
  table: Table,
  options?: SerializeOptions,
): Uint8Array {
  try {
    return tableToIPC(table, options?.format ?? 'stream')
  } catch (err) {
    const wrapped = new MemoryFrameError({
      code: 'MEMORY_FRAME_SERIALIZE_FAILED',
      message: 'Failed to serialize Arrow table to IPC bytes',
      context: { format: options?.format ?? 'stream' },
      cause: err,
    })
    logFrameError({
      component: 'ipc-serializer',
      operation: 'serializeToIPC',
      error: wrapped,
      context: wrapped.context,
    })
    throw wrapped
  }
}

/**
 * Deserialize IPC bytes to an Arrow Table.
 *
 * ERR-C-23: **throws** `MemoryFrameError('MEMORY_FRAME_DESERIALIZE_FAILED')`
 * when `bytes` is not a valid Arrow IPC payload. It previously returned an
 * empty table, making a truncated/corrupt frame indistinguishable from an
 * empty one — a corrupt import surfaced to the caller as "No records found"
 * on HTTP 200.
 *
 * A zero-length input is the one genuinely ambiguous case; it is treated as
 * corrupt (an empty Arrow stream still carries a schema header, so zero bytes
 * are never a valid encoding of an empty table).
 */
export function deserializeFromIPC(bytes: Uint8Array): Table {
  try {
    if (bytes.byteLength === 0) {
      throw new Error('empty payload: zero bytes is not a valid Arrow IPC frame')
    }
    const table = tableFromIPC(bytes)
    // `tableFromIPC` does not reliably throw: apache-arrow 19 returns a
    // schema-less 0-column table for short or unrecognisable input rather than
    // raising. A schema-less table is precisely the ambiguity this finding is
    // about — it is indistinguishable from a genuinely empty frame — so treat
    // it as a decode failure. A real empty frame still carries its schema.
    if (table.schema.fields.length === 0) {
      throw new Error(
        'payload decoded to a schema-less table (no Arrow schema block found)',
      )
    }
    return table
  } catch (err) {
    const wrapped = new MemoryFrameError({
      code: 'MEMORY_FRAME_DESERIALIZE_FAILED',
      message: 'Memory frame is not valid Arrow IPC',
      context: { byteLength: bytes.byteLength },
      cause: err,
    })
    logFrameError({
      component: 'ipc-serializer',
      operation: 'deserializeFromIPC',
      error: wrapped,
      context: wrapped.context,
    })
    throw wrapped
  }
}

/**
 * Deserialize IPC bytes, returning an empty table instead of throwing.
 *
 * Escape hatch for the handful of call sites that genuinely want best-effort
 * behaviour. It still logs the failure, so a corrupt payload is never silent.
 */
export function tryDeserializeFromIPC(bytes: Uint8Array): Table | undefined {
  try {
    return deserializeFromIPC(bytes)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

/**
 * Encode IPC bytes to a base64 string for text-based transport.
 */
export function ipcToBase64(bytes: Uint8Array): string {
  try {
    return Buffer.from(bytes).toString('base64')
  } catch {
    return ''
  }
}

/**
 * Decode a base64 string back to IPC bytes.
 */
export function base64ToIPC(b64: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  } catch {
    return new Uint8Array(0)
  }
}
