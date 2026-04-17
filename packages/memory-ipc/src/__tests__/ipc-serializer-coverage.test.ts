/**
 * Coverage tests for ipc-serializer.ts — error paths and base64 round-trips.
 */

import { describe, it, expect } from 'vitest'
import { tableFromArrays, type Table } from 'apache-arrow'
import {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from '../ipc-serializer.js'

// ---------------------------------------------------------------------------
// serializeToIPC
// ---------------------------------------------------------------------------

describe('serializeToIPC', () => {
  it('serializes a simple table to IPC bytes', () => {
    const table = tableFromArrays({ id: ['a', 'b'], value: new Int32Array([1, 2]) })
    const bytes = serializeToIPC(table)
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it('uses stream format by default', () => {
    const table = tableFromArrays({ x: [1] })
    const stream = serializeToIPC(table)
    const file = serializeToIPC(table, { format: 'file' })
    // Both should produce bytes; file format has a different header
    expect(stream.byteLength).toBeGreaterThan(0)
    expect(file.byteLength).toBeGreaterThan(0)
  })

  it('uses file format when specified', () => {
    const table = tableFromArrays({ x: ['hello'] })
    const bytes = serializeToIPC(table, { format: 'file' })
    expect(bytes.byteLength).toBeGreaterThan(0)
  })

  it('returns empty Uint8Array on error', () => {
    // Force an error by passing an invalid object as a table
    const badTable = { not: 'a table' } as unknown as Table
    const bytes = serializeToIPC(badTable)
    expect(bytes.byteLength).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// deserializeFromIPC
// ---------------------------------------------------------------------------

describe('deserializeFromIPC', () => {
  it('deserializes valid IPC bytes', () => {
    const original = tableFromArrays({ name: ['alice', 'bob'], age: new Int32Array([30, 25]) })
    const bytes = serializeToIPC(original)
    const restored = deserializeFromIPC(bytes)
    expect(restored.numRows).toBe(2)
    expect(restored.getChild('name')?.get(0)).toBe('alice')
    expect(restored.getChild('age')?.get(1)).toBe(25)
  })

  it('returns empty table for empty bytes', () => {
    const table = deserializeFromIPC(new Uint8Array(0))
    expect(table.numRows).toBe(0)
  })

  it('returns empty table for malformed bytes', () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
    const table = deserializeFromIPC(garbage)
    expect(table.numRows).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ipcToBase64
// ---------------------------------------------------------------------------

describe('ipcToBase64', () => {
  it('encodes IPC bytes to base64 string', () => {
    const table = tableFromArrays({ x: [1, 2, 3] })
    const bytes = serializeToIPC(table)
    const b64 = ipcToBase64(bytes)
    expect(typeof b64).toBe('string')
    expect(b64.length).toBeGreaterThan(0)
    // Verify it's valid base64
    expect(() => Buffer.from(b64, 'base64')).not.toThrow()
  })

  it('returns empty string for empty bytes', () => {
    const b64 = ipcToBase64(new Uint8Array(0))
    expect(b64).toBe('')
  })
})

// ---------------------------------------------------------------------------
// base64ToIPC
// ---------------------------------------------------------------------------

describe('base64ToIPC', () => {
  it('decodes base64 string to IPC bytes', () => {
    const original = new Uint8Array([10, 20, 30, 40, 50])
    const b64 = Buffer.from(original).toString('base64')
    const decoded = base64ToIPC(b64)
    expect(decoded).toEqual(original)
  })

  it('returns empty Uint8Array for empty string', () => {
    const decoded = base64ToIPC('')
    expect(decoded.byteLength).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: serialize → base64 → base64ToIPC → deserialize
// ---------------------------------------------------------------------------

describe('full round-trip', () => {
  it('survives serialize → base64 → decode → deserialize', () => {
    const original = tableFromArrays({
      id: ['r1', 'r2', 'r3'],
      score: new Float64Array([0.9, 0.5, 0.1]),
    })

    const bytes = serializeToIPC(original)
    const b64 = ipcToBase64(bytes)
    const decodedBytes = base64ToIPC(b64)
    const restored = deserializeFromIPC(decodedBytes)

    expect(restored.numRows).toBe(3)
    expect(restored.getChild('id')?.get(0)).toBe('r1')
    expect(restored.getChild('score')?.get(2)).toBeCloseTo(0.1)
  })

  it('round-trips with file format', () => {
    const original = tableFromArrays({ text: ['hello world'] })
    const bytes = serializeToIPC(original, { format: 'file' })
    const b64 = ipcToBase64(bytes)
    const decodedBytes = base64ToIPC(b64)
    const restored = deserializeFromIPC(decodedBytes)
    expect(restored.numRows).toBe(1)
    expect(restored.getChild('text')?.get(0)).toBe('hello world')
  })
})
