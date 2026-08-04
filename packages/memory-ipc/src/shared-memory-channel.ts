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
 * Uses Atomics for thread-safe state transitions and a CAS-based bump allocator
 * with wrap-around for the data region.
 *
 * **Multi-writer safety:** Safe for concurrent async writes within a single
 * Node.js process. Both slot acquisition (CAS: FREE -> WRITING) and data
 * allocation (CAS bump pointer) are atomic. Cross-process multi-writer
 * requires external coordination (e.g. file locks or a dedicated allocator process).
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
  /**
   * Opt-in to multi-writer mode.
   *
   * **Default: false (single-writer contract enforced).**
   *
   * This channel's CAS-based allocator is safe for concurrent async writes
   * within a **single** Node.js process. Cross-process multi-writer requires
   * external coordination (e.g. file locks or a dedicated allocator process)
   * because the CAS loop assumes a shared event loop that cannot be preempted
   * between the load and compareExchange calls.
   *
   * When `multiWriter` is false (the default), calling `write()` or
   * `writeTable()` after the channel was constructed with `existingBuffer`
   * (i.e. on the worker/consumer side) throws immediately with a descriptive
   * error. This prevents accidental cross-process write races.
   *
   * Set to `true` only when you have verified external coordination and accept
   * the cross-process safety limitations documented above.
   */
  multiWriter?: boolean
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
  /**
   * True when this instance was created from an existingBuffer (consumer/worker side).
   * Used to enforce the single-writer contract when multiWriter is false.
   */
  private readonly isConsumerSide: boolean
  private readonly multiWriter: boolean

  constructor(options?: SharedMemoryChannelOptions) {
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxSlots = options?.maxSlots ?? DEFAULT_MAX_SLOTS
    this.multiWriter = options?.multiWriter ?? false

    // Header size = (HEADER_INTS + maxSlots * SLOT_INTS) * 4 bytes
    const headerBytes =
      (HEADER_INTS + this.maxSlots * SLOT_INTS) * BYTES_PER_INT32
    this.dataRegionOffset = headerBytes

    if (options?.existingBuffer) {
      this.sab = options.existingBuffer
      this.dataRegionSize = this.sab.byteLength - headerBytes
      this.isConsumerSide = true
    } else {
      // Total buffer: header + data region
      const totalBytes = headerBytes + maxBytes
      this.sab = new SharedArrayBuffer(totalBytes)
      this.dataRegionSize = maxBytes
      this.isConsumerSide = false

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
    this.assertWriteAllowed()
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

    // Allocate space in data region (bump allocator).
    // AGENT-C-10: this can now refuse to allocate rather than wrap over bytes
    // a reader still holds a zero-copy view into. Release the slot we just
    // claimed so a refused write does not leak it.
    let offset: number
    try {
      offset = this.allocateData(ipcBytes.byteLength, slotIndex)
    } catch (err) {
      Atomics.store(this.int32View, this.slotMetaIndex(slotIndex) + 2, SlotState.FREE)
      Atomics.notify(this.int32View, this.slotMetaIndex(slotIndex) + 2)
      throw err
    }

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
    let ipcBytes: Uint8Array
    try {
      ipcBytes = serializeToIPC(table)
    } catch (err) {
      throw new Error(
        'SharedMemoryChannel: failed to serialize table to IPC bytes',
        { cause: err },
      )
    }
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

  /**
   * Enforce the single-writer contract.
   *
   * Throws if this instance was created with `existingBuffer` (consumer side) and
   * `multiWriter` is false. Consumer-side instances must not write — only the
   * original producer (the process that created the SharedArrayBuffer) is the
   * designated writer. This prevents silent cross-process write races that the
   * in-process CAS loop cannot prevent.
   */
  private assertWriteAllowed(): void {
    if (this.isConsumerSide && !this.multiWriter) {
      throw new Error(
        'SharedMemoryChannel: write() called on a consumer-side instance (constructed with existingBuffer). ' +
        'Only the producer process that created the SharedArrayBuffer may write. ' +
        'To allow cross-process writes, pass { multiWriter: true } — but note that ' +
        'cross-process multi-writer safety requires external coordination (e.g. file locks).',
      )
    }
  }

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

  /**
   * Bump-allocate data in the data region. Returns offset relative to data region start.
   *
   * **Multi-writer safety:** Uses compareExchange (CAS) to atomically claim space.
   * Safe for concurrent async writes within a single Node.js process. Cross-process
   * multi-writer requires external coordination (e.g. file locks or a dedicated
   * allocator process).
   *
   * **AGENT-C-10 — live-region protection.** `read()` hands out a
   * `Uint8Array.subarray` view directly into the SharedArrayBuffer (zero copy),
   * and a slot stays live until `release()` is called. The bump pointer used to
   * wrap to offset 0 whenever the next write did not fit, memcpy'ing the new
   * payload straight over bytes that outstanding readers were still looking at
   * — silent, undetectable corruption of in-flight reads.
   *
   * The allocator now refuses to hand out any region that overlaps a live
   * (WRITING / READY / CLAIMED) slot's byte range and throws instead. The
   * caller must `release()` outstanding handles, or the channel must be sized
   * larger, before the write can proceed.
   */
  private allocateData(size: number, excludeSlot: number): number {
    // CAS loop: atomically claim space in the bump allocator.
    // Retries on contention from concurrent async writers.
    const MAX_CAS_RETRIES = 64
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const currentOffset = Atomics.load(this.int32View, 1)
      let claimedOffset = currentOffset
      let newOffset = currentOffset + size

      if (newOffset > this.dataRegionSize) {
        // Wrap around to beginning
        claimedOffset = 0
        newOffset = size
      }

      // Refuse to reuse bytes that a reader may still hold a view into.
      const conflict = this.findLiveOverlap(claimedOffset, size, excludeSlot)
      if (conflict !== -1) {
        throw new Error(
          `SharedMemoryChannel: refusing to allocate ${size} bytes at data-region offset ` +
          `${claimedOffset} — the region overlaps live slot ${conflict} ` +
          `(offset=${Atomics.load(this.int32View, this.slotMetaIndex(conflict))}, ` +
          `length=${Atomics.load(this.int32View, this.slotMetaIndex(conflict) + 1)}), ` +
          'whose data may still be held as a zero-copy view by a reader. ' +
          'Call release() on outstanding slot handles or increase maxBytes.',
        )
      }

      // Atomically try to advance the write pointer
      const prev = Atomics.compareExchange(
        this.int32View,
        1,
        currentOffset,
        newOffset,
      )

      if (prev === currentOffset) {
        // CAS succeeded — we own [claimedOffset, claimedOffset + size)
        return claimedOffset
      }
      // CAS failed — another writer moved the pointer; retry
    }

    throw new Error(
      `SharedMemoryChannel: allocateData CAS failed after ${MAX_CAS_RETRIES} retries (contention too high)`,
    )
  }

  /**
   * Return the index of the first non-FREE slot whose byte range intersects
   * `[offset, offset + size)`, or -1 when the region is safe to reuse.
   *
   * `excludeSlot` is the slot the current writer already owns (state WRITING,
   * length still 0) and is skipped.
   */
  private findLiveOverlap(
    offset: number,
    size: number,
    excludeSlot: number,
  ): number {
    const end = offset + size
    for (let i = 0; i < this.maxSlots; i++) {
      if (i === excludeSlot) continue
      const slotBase = this.slotMetaIndex(i)
      const state = Atomics.load(this.int32View, slotBase + 2)
      if (state === SlotState.FREE) continue
      const slotLength = Atomics.load(this.int32View, slotBase + 1)
      if (slotLength <= 0) continue
      const slotOffset = Atomics.load(this.int32View, slotBase)
      if (offset < slotOffset + slotLength && slotOffset < end) return i
    }
    return -1
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
