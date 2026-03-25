/**
 * IPC serialization helpers for Arrow tables.
 *
 * Wraps apache-arrow's tableToIPC / tableFromIPC with non-fatal error handling
 * and base64 encoding for transport over text-based protocols (e.g. JSON, HTTP).
 */

import {
  type Table,
  tableToIPC,
  tableFromIPC,
  tableFromArrays,
} from 'apache-arrow'

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
 * Non-fatal: returns empty Uint8Array on error.
 */
export function serializeToIPC(
  table: Table,
  options?: SerializeOptions,
): Uint8Array {
  try {
    return tableToIPC(table, options?.format ?? 'stream')
  } catch {
    return new Uint8Array(0)
  }
}

/**
 * Deserialize IPC bytes to an Arrow Table.
 *
 * Non-fatal: returns empty Table on error.
 */
export function deserializeFromIPC(bytes: Uint8Array): Table {
  try {
    return tableFromIPC(bytes)
  } catch {
    return tableFromArrays({})
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
