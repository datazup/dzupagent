/**
 * ERR-C-23 — a corrupt Arrow payload must never present as a successful
 * "no records found" result.
 *
 * Before the fix, `deserializeFromIPC` swallowed every parse failure into
 * `tableFromArrays({})`, so `handleImportMemory` fell through to its
 * `table.numRows === 0` branch and returned
 * `{ imported: 0, warnings: ['No records found in import data'] }` — which the
 * HTTP layer serves as a 200. A truncated frame was indistinguishable from an
 * empty one.
 */

import { describe, it, expect } from 'vitest'
import { tableFromArrays } from 'apache-arrow'

import { serializeToIPC, deserializeFromIPC } from '../ipc-serializer.js'
import { isMemoryFrameError, MemoryFrameError } from '../ipc-errors.js'
import { handleImportMemory } from '../mcp-memory-transport.js'
import { ipcToBase64 } from '../ipc-serializer.js'
import { FrameBuilder } from '../frame-builder.js'

const noopDeps = {
  importFrame: async () => ({ imported: 0, skipped: 0, conflicts: 0 }),
}

describe('ERR-C-23 — corrupt payload vs empty result', () => {
  it('deserializeFromIPC throws a typed error on a corrupted buffer', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'hello' }, { id: 'r0', namespace: 'ns', key: 'k0' })
    const good = serializeToIPC(builder.build())

    // Corrupt the middle of an otherwise valid frame.
    const corrupt = new Uint8Array(good)
    for (let i = 8; i < Math.min(40, corrupt.length); i++) corrupt[i] = 0xff

    let thrown: unknown
    try {
      deserializeFromIPC(corrupt)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(MemoryFrameError)
    expect(isMemoryFrameError(thrown, 'MEMORY_FRAME_DESERIALIZE_FAILED')).toBe(true)
    expect((thrown as MemoryFrameError).context['byteLength']).toBe(
      corrupt.byteLength,
    )
    // Explicitly NOT an empty table.
    expect(thrown).not.toEqual(tableFromArrays({}))
  })

  it('handleImportMemory reports invalid_payload for a truncated Arrow frame', async () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'hello' }, { id: 'r0', namespace: 'ns', key: 'k0' })
    const good = serializeToIPC(builder.build())
    const truncated = good.subarray(0, Math.floor(good.byteLength / 2))

    const result = await handleImportMemory(
      {
        data: ipcToBase64(truncated),
        format: 'arrow_ipc',
        namespace: 'ns',
        merge_strategy: 'upsert',
      },
      noopDeps,
    )

    expect(result.status).toBe('invalid_payload')
    expect(result.imported).toBe(0)
    // The whole point of the finding: this must NOT read as "nothing to import".
    expect(result.warnings.join(' ')).not.toContain('No records found')
    expect(result.warnings.join(' ')).toContain('Invalid Arrow IPC payload')
  })

  it('handleImportMemory still reports status ok for a genuinely empty frame', async () => {
    // A real, schema-carrying frame with zero rows.
    const emptyFrame = serializeToIPC(new FrameBuilder().build())

    const result = await handleImportMemory(
      {
        data: ipcToBase64(emptyFrame),
        format: 'arrow_ipc',
        namespace: 'ns',
        merge_strategy: 'upsert',
      },
      noopDeps,
    )

    expect(result.status).toBe('ok')
    expect(result.imported).toBe(0)
    expect(result.warnings.join(' ')).toContain('No records found')
  })
})
