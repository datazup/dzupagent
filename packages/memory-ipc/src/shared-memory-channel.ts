/**
 * SharedMemoryChannel — zero-copy memory channel using SharedArrayBuffer + Atomics.
 *
 * Memory layout in the SharedArrayBuffer:
 *   [0..3]     Int32: slot count (maxSlots)
 *   [4..7]     Int32: next write offset in data region (relative to data region start)
 *   [8..N]     Slot metadata: per slot = [offset:Int32, length:Int32, state:Int32] (12 bytes each)
 *   [N+1..]    Data region: raw IPC bytes
 *
 * Slot states: 0=FREE, 1=WRITING, 2=READY, 3=CLAIMED
 *
 * Uses Atomics for thread-safe state transitions and a bump allocator with
 * wrap-around for the data region.
 */

import { type Table } from 'apache-arrow'
import { serializeToIPC, deserializeFromIPC } from './ipc-serializer.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024 // 64 MB
const DEFAULT_MAX_SLOTS = 16

const HEADER_INTS = 2 // slot_count + next_write_offset
const SLOT_INTS = 3 // offset, length, state per slot
const BYTES_PER_INT32 = 4

/** Slot state machine values. */
const SlotState = {
  FREE: 0,
  WRITING: 1,
  READY: 2,
  CLAIMED: 3,
} as const

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for creating a SharedMemoryChannel. */
export interface SharedMemoryChannelOptions {
  /** Max buffer size in bytes. Default: 64MB */
  maxBytes?: number
  /** Max concurrent slots. Default: 16 */
  maxSlots?: number
  /** Use an existing SharedArrayBuffer (for worker side). */
  existingBuffer?: SharedArrayBuffer
}

/** Handle returned from a write operation, used to read or release the slot. */
export interface SlotHandle {
  slotIndex: number
  offset: number
  length: number
}

// ---------------------------------------------------------------------------
// SharedMemoryChannel
// ---------------------------------------------------------------------------

export class SharedMemoryChannel {
  private readonly sab: SharedArrayBuffer
  private readonly int32View: Int32Array
  private readonly uint8View: Uint8Array
  private readonly maxSlots: number
  private readonly dataRegionOffset: number
  private readonly dataRegionSize: number

  constructor(options?: SharedMemoryChannelOptions) {
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxSlots = options?.maxSlots ?? DEFAULT_MAX_SLOTS

    // Header size = (HEADER_INTS + maxSlots * SLOT_INTS) * 4 bytes
    const headerBytes =
      (HEADER_INTS + this.maxSlots * SLOT_INTS) * BYTES_PER_INT32
    this.dataRegionOffset = headerBytes

    if (options?.existingBuffer) {
      this.sab = options.existingBuffer
      this.dataRegionSize = this.sab.byteLength - headerBytes
    } else {
      // Total buffer: header + data region
      const totalBytes = headerBytes + maxBytes
      this.sab = new SharedArrayBuffer(totalBytes)
      this.dataRegionSize = maxBytes

      // Initialize header
      const view = new Int32Array(this.sab, 0, HEADER_INTS)
      Atomics.store(view, 0, this.maxSlots)
      Atomics.store(view, 1, 0) // next write offset = 0
    }

    this.int32View = new Int32Array(this.sab)
    this.uint8View = new Uint8Array(this.sab)
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Get the underlying SharedArrayBuffer (for posting to workers). */
  get sharedBuffer(): SharedArrayBuffer {
    return this.sab
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /** Write raw IPC bytes to the channel. Returns a handle for readers. */
  write(ipcBytes: Uint8Array): SlotHandle {
    if (ipcBytes.byteLength === 0) {
      throw new Error('SharedMemoryChannel: cannot write zero-length data')
    }
    if (ipcBytes.byteLength > this.dataRegionSize) {
      throw new Error(
        `SharedMemoryChannel: data size ${ipcBytes.byteLength} exceeds data region ${this.dataRegionSize}`,
      )
    }

    // Find a free slot
    const slotIndex = this.acquireFreeSlot()
    if (slotIndex === -1) {
      throw new Error('SharedMemoryChannel: no free slots available')
    }

    // Allocate space in data region (bump allocator)
    const offset = this.allocateData(ipcBytes.byteLength)

    // Copy data into the SharedArrayBuffer data region
    const absoluteOffset = this.dataRegionOffset + offset
    this.uint8View.set(ipcBytes, absoluteOffset)

    // Write slot metadata
    const slotBase = this.slotMetaIndex(slotIndex)
    Atomics.store(this.int32View, slotBase, offset)
    Atomics.store(this.int32View, slotBase + 1, ipcBytes.byteLength)

    // Transition: WRITING -> READY
    Atomics.store(this.int32View, slotBase + 2, SlotState.READY)
    // Notify any waiters on the state position
    Atomics.notify(this.int32View, slotBase + 2)

    return { slotIndex, offset, length: ipcBytes.byteLength }
  }

  /** Write an Arrow Table (serializes to IPC first). */
  writeTable(table: Table): SlotHandle {
    const ipcBytes = serializeToIPC(table)
    if (ipcBytes.byteLength === 0) {
      throw new Error(
        'SharedMemoryChannel: failed to serialize table to IPC bytes',
      )
    }
    return this.write(ipcBytes)
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Read IPC bytes from a slot (view into SharedArrayBuffer — zero copy). */
  read(handle: SlotHandle): Uint8Array {
    this.validateHandle(handle)

    const slotBase = this.slotMetaIndex(handle.slotIndex)
    const state = Atomics.load(this.int32View, slotBase + 2)

    if (state !== SlotState.READY && state !== SlotState.CLAIMED) {
      throw new Error(
        `SharedMemoryChannel: slot ${handle.slotIndex} is not readable (state=${state})`,
      )
    }

    // Transition to CLAIMED if currently READY
    if (state === SlotState.READY) {
      Atomics.compareExchange(
        this.int32View,
        slotBase + 2,
        SlotState.READY,
        SlotState.CLAIMED,
      )
    }

    const absoluteOffset = this.dataRegionOffset + handle.offset
    // Return a view — zero copy
    return this.uint8View.subarray(
      absoluteOffset,
      absoluteOffset + handle.length,
    )
  }

  /** Read and deserialize to Arrow Table. */
  readTable(handle: SlotHandle): Table {
    const bytes = this.read(handle)
    // We must copy to a regular ArrayBuffer for Arrow deserialization,
    // because Arrow's IPC reader may not support SharedArrayBuffer views
    const copied = new Uint8Array(bytes.byteLength)
    copied.set(bytes)
    return deserializeFromIPC(copied)
  }

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  /** Release a slot for reuse. */
  release(handle: SlotHandle): void {
    this.validateHandle(handle)

    const slotBase = this.slotMetaIndex(handle.slotIndex)
    // Reset slot metadata
    Atomics.store(this.int32View, slotBase, 0)
    Atomics.store(this.int32View, slotBase + 1, 0)
    Atomics.store(this.int32View, slotBase + 2, SlotState.FREE)
    Atomics.notify(this.int32View, slotBase + 2)
  }

  /** Reset all slots and the write offset. */
  dispose(): void {
    // Reset write offset
    Atomics.store(this.int32View, 1, 0)

    // Reset all slots
    for (let i = 0; i < this.maxSlots; i++) {
      const slotBase = this.slotMetaIndex(i)
      Atomics.store(this.int32View, slotBase, 0)
      Atomics.store(this.int32View, slotBase + 1, 0)
      Atomics.store(this.int32View, slotBase + 2, SlotState.FREE)
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Get the Int32Array index for a slot's first metadata field. */
  private slotMetaIndex(slotIndex: number): number {
    return HEADER_INTS + slotIndex * SLOT_INTS
  }

  /** Find and acquire a free slot (CAS: FREE -> WRITING). Returns -1 if none. */
  private acquireFreeSlot(): number {
    for (let i = 0; i < this.maxSlots; i++) {
      const stateIdx = this.slotMetaIndex(i) + 2
      const prev = Atomics.compareExchange(
        this.int32View,
        stateIdx,
        SlotState.FREE,
        SlotState.WRITING,
      )
      if (prev === SlotState.FREE) {
        return i
      }
    }
    return -1
  }

  /** Bump-allocate data in the data region. Returns offset relative to data region start. */
  private allocateData(size: number): number {
    // Simple bump allocator with wrap-around
    // Use Atomics.add to atomically claim space
    const currentOffset = Atomics.load(this.int32View, 1)
    let newOffset = currentOffset + size

    if (newOffset > this.dataRegionSize) {
      // Wrap around to beginning
      // Note: in a real concurrent scenario this would need more sophisticated handling.
      // For our use case (single writer thread), this is sufficient.
      Atomics.store(this.int32View, 1, size)
      return 0
    }

    Atomics.store(this.int32View, 1, newOffset)
    return currentOffset
  }

  /** Validate that a handle references a valid slot index. */
  private validateHandle(handle: SlotHandle): void {
    if (handle.slotIndex < 0 || handle.slotIndex >= this.maxSlots) {
      throw new Error(
        `SharedMemoryChannel: invalid slot index ${handle.slotIndex} (max=${this.maxSlots})`,
      )
    }
  }
}
