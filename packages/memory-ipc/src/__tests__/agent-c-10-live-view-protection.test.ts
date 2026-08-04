/**
 * AGENT-C-10 — the shared-buffer bump allocator must not wrap over slots that
 * readers still hold zero-copy views into.
 *
 * `read()` returns a `Uint8Array.subarray` directly into the SharedArrayBuffer.
 * The allocator previously reset the bump pointer to 0 whenever the next write
 * did not fit, and `write()` then memcpy'd the new payload straight over those
 * bytes — silently mutating data a live reader was still looking at.
 */

import { describe, it, expect } from "vitest";

import { SharedMemoryChannel } from "../shared-memory-channel.js";

describe("AGENT-C-10 — live zero-copy views are not overwritten", () => {
  it("refuses to wrap over a slot a reader still holds, and leaves the read intact", () => {
    const channel = new SharedMemoryChannel({ maxSlots: 8, maxBytes: 100 });

    const payload = new Uint8Array(60).fill(0xa1);
    const handle = channel.write(payload);

    // Reader takes a zero-copy view and keeps holding it.
    // `filter(...).toHaveLength(n)` rather than `every(...)`: it asserts the
    // byte count AND the predicate together, so it cannot pass vacuously if
    // `read()` ever returns an empty view — which is exactly the corruption
    // this test exists to catch.
    const view = channel.read(handle);
    expect(view.filter((b) => b === 0xa1)).toHaveLength(60);

    // 60 + 60 = 120 > 100 → the allocator would wrap to offset 0, straight over
    // `view`. It must refuse loudly instead.
    expect(() => channel.write(new Uint8Array(60).fill(0xb2))).toThrow(
      /overlaps live slot/
    );

    // The reader's data is untouched — no silent corruption.
    expect(view.filter((b) => b === 0xa1)).toHaveLength(60);
    expect(channel.read(handle).filter((b) => b === 0xa1)).toHaveLength(60);
  });

  it("a refused write does not leak the slot it acquired", () => {
    const channel = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 100 });
    const handle = channel.write(new Uint8Array(60).fill(0xa1));
    channel.read(handle);

    // Two refused attempts: if the slot leaked, the second would fail with
    // "no free slots available" instead of the overlap error.
    expect(() => channel.write(new Uint8Array(60).fill(0xb2))).toThrow(
      /overlaps live slot/
    );
    expect(() => channel.write(new Uint8Array(60).fill(0xb3))).toThrow(
      /overlaps live slot/
    );

    // After release the wrap is safe again.
    channel.release(handle);
    const next = channel.write(new Uint8Array(60).fill(0xb4));
    expect(next.offset).toBe(0);
    expect(channel.read(next).filter((b) => b === 0xb4)).toHaveLength(60);
  });

  it("wrapping is still allowed when no live slot occupies the region", () => {
    const channel = new SharedMemoryChannel({ maxSlots: 8, maxBytes: 200 });
    const h1 = channel.write(new Uint8Array(50).fill(0xa1));
    const h2 = channel.write(new Uint8Array(50).fill(0xa2));
    const h3 = channel.write(new Uint8Array(50).fill(0xa3));
    channel.release(h1);
    channel.release(h2);
    channel.release(h3);

    const h4 = channel.write(new Uint8Array(80).fill(0xa4));
    expect(h4.offset).toBe(0);
  });

  it("partial release still blocks a wrap that would overlap the remaining live slot", () => {
    const channel = new SharedMemoryChannel({ maxSlots: 8, maxBytes: 200 });
    const h1 = channel.write(new Uint8Array(50).fill(0xa1)); // [0, 50)
    const h2 = channel.write(new Uint8Array(50).fill(0xa2)); // [50, 100)
    const h3 = channel.write(new Uint8Array(50).fill(0xa3)); // [100, 150)
    const liveView = channel.read(h1);
    channel.release(h2);
    channel.release(h3);

    // Bump pointer at 150; an 80-byte write wraps to 0 and would clobber h1.
    expect(() => channel.write(new Uint8Array(80).fill(0xa4))).toThrow(
      /overlaps live slot/
    );
    expect(liveView.filter((b) => b === 0xa1)).toHaveLength(50);
  });
});
