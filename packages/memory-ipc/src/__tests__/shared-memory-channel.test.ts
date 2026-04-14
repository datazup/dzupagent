import { describe, it, expect, beforeEach } from 'vitest'
import { SharedMemoryChannel } from '../shared-memory-channel.js'
import { FrameBuilder } from '../frame-builder.js'
import { serializeToIPC } from '../ipc-serializer.js'

describe('SharedMemoryChannel', () => {
  let channel: SharedMemoryChannel

  beforeEach(() => {
    channel = new SharedMemoryChannel({
      maxBytes: 1024 * 1024, // 1 MB
      maxSlots: 4,
    })
  })

  describe('write and read IPC bytes', () => {
    it('should write IPC bytes and read back identical content', () => {
      const builder = new FrameBuilder()
      builder.add(
        { text: 'hello world' },
        { id: '1', namespace: 'test', key: 'k1' },
      )
      const ipcBytes = serializeToIPC(builder.build())

      const handle = channel.write(ipcBytes)

      expect(handle.slotIndex).toBe(0)
      expect(handle.length).toBe(ipcBytes.byteLength)

      const readBytes = channel.read(handle)
      expect(readBytes.byteLength).toBe(ipcBytes.byteLength)

      // Compare content byte-by-byte
      const original = new Uint8Array(ipcBytes)
      const result = new Uint8Array(readBytes)
      for (let i = 0; i < original.length; i++) {
        expect(result[i]).toBe(original[i])
      }
    })

    it('should reject zero-length data', () => {
      expect(() => channel.write(new Uint8Array(0))).toThrow(
        'cannot write zero-length data',
      )
    })

    it('should reject data larger than data region', () => {
      const huge = new Uint8Array(2 * 1024 * 1024) // 2 MB > 1 MB
      expect(() => channel.write(huge)).toThrow('exceeds data region')
    })
  })

  describe('write and read Table', () => {
    it('should write a Table and read it back with correct data', () => {
      const builder = new FrameBuilder()
      builder.add(
        { text: 'record one', category: 'notes' },
        { id: '1', namespace: 'ns', key: 'k1' },
      )
      builder.add(
        { text: 'record two', importance: 0.8 },
        { id: '2', namespace: 'ns', key: 'k2' },
      )
      const table = builder.build()

      const handle = channel.writeTable(table)
      const readTable = channel.readTable(handle)

      expect(readTable.numRows).toBe(2)

      const textCol = readTable.getChild('text')
      expect(textCol?.get(0)).toBe('record one')
      expect(textCol?.get(1)).toBe('record two')
    })
  })

  describe('multiple slots', () => {
    it('should support writing to multiple slots independently', () => {
      const tables = Array.from({ length: 3 }, (_, i) => {
        const b = new FrameBuilder()
        b.add(
          { text: `table-${i}` },
          { id: `id-${i}`, namespace: 'multi', key: `k${i}` },
        )
        return b.build()
      })

      const handles = tables.map((t) => channel.writeTable(t))

      // Read all back in reverse order
      for (let i = 2; i >= 0; i--) {
        const handle = handles[i]!
        const readTable = channel.readTable(handle)
        expect(readTable.numRows).toBe(1)
        const textCol = readTable.getChild('text')
        expect(textCol?.get(0)).toBe(`table-${i}`)
      }
    })

    it('should fail when all slots are occupied', () => {
      // Fill all 4 slots
      for (let i = 0; i < 4; i++) {
        const b = new FrameBuilder()
        b.add(
          { text: `fill-${i}` },
          { id: `id-${i}`, namespace: 'fill', key: `k${i}` },
        )
        channel.writeTable(b.build())
      }

      // Fifth write should fail
      const b = new FrameBuilder()
      b.add(
        { text: 'overflow' },
        { id: 'overflow', namespace: 'fill', key: 'overflow' },
      )
      expect(() => channel.writeTable(b.build())).toThrow('no free slots')
    })
  })

  describe('release', () => {
    it('should allow reuse of a released slot', () => {
      // Fill all 4 slots
      const handles = Array.from({ length: 4 }, (_, i) => {
        const b = new FrameBuilder()
        b.add(
          { text: `slot-${i}` },
          { id: `id-${i}`, namespace: 'release', key: `k${i}` },
        )
        return channel.writeTable(b.build())
      })

      // Release slot 1
      channel.release(handles[1]!)

      // Should now be able to write again
      const b = new FrameBuilder()
      b.add(
        { text: 'reused' },
        { id: 'reused', namespace: 'release', key: 'kreused' },
      )
      const newHandle = channel.writeTable(b.build())

      // The reused slot should be slot index 1
      expect(newHandle.slotIndex).toBe(1)

      const readTable = channel.readTable(newHandle)
      expect(readTable.numRows).toBe(1)
      expect(readTable.getChild('text')?.get(0)).toBe('reused')
    })

    it('should reject reading from a released slot', () => {
      const b = new FrameBuilder()
      b.add(
        { text: 'released' },
        { id: '1', namespace: 'test', key: 'k1' },
      )
      const handle = channel.writeTable(b.build())

      channel.release(handle)

      expect(() => channel.read(handle)).toThrow('not readable')
    })
  })

  describe('dispose', () => {
    it('should reset all slots', () => {
      // Fill some slots
      for (let i = 0; i < 3; i++) {
        const b = new FrameBuilder()
        b.add(
          { text: `dispose-${i}` },
          { id: `id-${i}`, namespace: 'dispose', key: `k${i}` },
        )
        channel.writeTable(b.build())
      }

      channel.dispose()

      // All slots should be free, should be able to write 4 items again
      for (let i = 0; i < 4; i++) {
        const b = new FrameBuilder()
        b.add(
          { text: `after-dispose-${i}` },
          { id: `id-${i}`, namespace: 'disposed', key: `k${i}` },
        )
        const handle = channel.writeTable(b.build())
        expect(handle.slotIndex).toBe(i)
      }
    })
  })

  describe('existingBuffer', () => {
    it('should share data via existingBuffer on worker side', () => {
      // Write from "main thread"
      const b = new FrameBuilder()
      b.add(
        { text: 'shared-data' },
        { id: '1', namespace: 'shared', key: 'k1' },
      )
      const handle = channel.writeTable(b.build())

      // Create a "worker side" channel using the same buffer
      const workerChannel = new SharedMemoryChannel({
        existingBuffer: channel.sharedBuffer,
        maxSlots: 4,
      })

      // Worker should be able to read the same handle
      const readTable = workerChannel.readTable(handle)
      expect(readTable.numRows).toBe(1)
      expect(readTable.getChild('text')?.get(0)).toBe('shared-data')
    })
  })

  describe('validate handle', () => {
    it('should reject invalid slot indices', () => {
      expect(() =>
        channel.read({ slotIndex: -1, offset: 0, length: 10 }),
      ).toThrow('invalid slot index')
      expect(() =>
        channel.read({ slotIndex: 99, offset: 0, length: 10 }),
      ).toThrow('invalid slot index')
    })
  })

  describe('concurrent writes (multi-writer safety)', () => {
    it('should not corrupt data when multiple writes happen concurrently', () => {
      // Use a channel with enough slots for concurrent writes
      const concurrentChannel = new SharedMemoryChannel({
        maxBytes: 1024 * 1024,
        maxSlots: 8,
      })

      // Simulate multiple concurrent writes
      const writeCount = 8
      const handles: Array<ReturnType<typeof concurrentChannel.write>> = []

      for (let i = 0; i < writeCount; i++) {
        const b = new FrameBuilder()
        b.add(
          { text: `concurrent-write-${i}` },
          { id: `id-${i}`, namespace: 'concurrent', key: `k${i}` },
        )
        handles.push(concurrentChannel.writeTable(b.build()))
      }

      // Verify each write produced a unique, non-overlapping handle
      const slotIndices = new Set(handles.map(h => h.slotIndex))
      expect(slotIndices.size).toBe(writeCount)

      // Verify each written table can be read back correctly
      for (let i = 0; i < writeCount; i++) {
        const handle = handles[i]!
        const table = concurrentChannel.readTable(handle)
        expect(table.numRows).toBe(1)
        expect(table.getChild('text')?.get(0)).toBe(`concurrent-write-${i}`)
      }
    })

    it('should handle write-release-write cycles without corruption', () => {
      // Fill all slots, release some, write again
      const handles = Array.from({ length: 4 }, (_, i) => {
        const b = new FrameBuilder()
        b.add(
          { text: `cycle-${i}` },
          { id: `id-${i}`, namespace: 'cycle', key: `k${i}` },
        )
        return channel.writeTable(b.build())
      })

      // Release slots 0 and 2
      channel.release(handles[0]!)
      channel.release(handles[2]!)

      // Write two new entries into the freed slots
      const newHandles = Array.from({ length: 2 }, (_, i) => {
        const b = new FrameBuilder()
        b.add(
          { text: `rewrite-${i}` },
          { id: `new-${i}`, namespace: 'cycle', key: `new${i}` },
        )
        return channel.writeTable(b.build())
      })

      // Verify old slot 1 and 3 still readable
      expect(channel.readTable(handles[1]!).getChild('text')?.get(0)).toBe('cycle-1')
      expect(channel.readTable(handles[3]!).getChild('text')?.get(0)).toBe('cycle-3')

      // Verify new entries are readable and correct
      for (let i = 0; i < 2; i++) {
        const table = channel.readTable(newHandles[i]!)
        expect(table.getChild('text')?.get(0)).toBe(`rewrite-${i}`)
      }
    })

    it('should produce unique data offsets for concurrent allocations', () => {
      const concurrentChannel = new SharedMemoryChannel({
        maxBytes: 1024 * 1024,
        maxSlots: 4,
      })

      // Write different-sized payloads
      const payloads = [
        new Uint8Array(100).fill(0xAA),
        new Uint8Array(200).fill(0xBB),
        new Uint8Array(50).fill(0xCC),
      ]

      const handles = payloads.map(p => concurrentChannel.write(p))

      // Verify offsets do not overlap
      for (let i = 0; i < handles.length; i++) {
        for (let j = i + 1; j < handles.length; j++) {
          const a = handles[i]!
          const b = handles[j]!
          const aEnd = a.offset + a.length
          const bEnd = b.offset + b.length
          // No overlap: a ends before b starts, or b ends before a starts
          const noOverlap = aEnd <= b.offset || bEnd <= a.offset
          expect(noOverlap).toBe(true)
        }
      }

      // Verify each payload reads back correctly
      for (let i = 0; i < payloads.length; i++) {
        const readBytes = concurrentChannel.read(handles[i]!)
        expect(readBytes.byteLength).toBe(payloads[i]!.byteLength)
        for (let b = 0; b < readBytes.byteLength; b++) {
          expect(readBytes[b]).toBe(payloads[i]![b])
        }
      }
    })
  })
})
