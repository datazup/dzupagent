/**
 * Hybrid Logical Clock (HLC) implementation.
 *
 * Provides monotonically increasing timestamps that combine physical wall-clock
 * time with a logical counter and node identifier. This gives a total ordering
 * across distributed nodes without requiring clock synchronization.
 *
 * Properties:
 * - Monotonically increasing on each node
 * - Causally consistent across nodes (via receive())
 * - Total ordering via (wallMs, counter, nodeId) tuple
 */

import type { HLCTimestamp } from './types.js'

export class HLC {
  private lastWallMs = 0
  private lastCounter = 0

  constructor(private readonly nodeId: string) {}

  /**
   * Generate a new timestamp, guaranteed monotonically increasing on this node.
   *
   * - wallMs = max(Date.now(), lastWallMs)
   * - If same wallMs as last, increment counter; else reset counter to 0
   */
  now(): HLCTimestamp {
    const physicalMs = Date.now()
    const wallMs = Math.max(physicalMs, this.lastWallMs)

    let counter: number
    if (wallMs === this.lastWallMs) {
      counter = this.lastCounter + 1
    } else {
      counter = 0
    }

    this.lastWallMs = wallMs
    this.lastCounter = counter

    return { wallMs, counter, nodeId: this.nodeId }
  }

  /**
   * Update local clock on receiving a remote timestamp.
   *
   * Advances the local clock to be at least as far as the remote,
   * ensuring causal consistency.
   */
  receive(remote: HLCTimestamp): HLCTimestamp {
    const physicalMs = Date.now()
    const wallMs = Math.max(physicalMs, remote.wallMs, this.lastWallMs)

    let counter: number
    if (wallMs === remote.wallMs && wallMs === this.lastWallMs) {
      // All three tie: take max of both counters + 1
      counter = Math.max(this.lastCounter, remote.counter) + 1
    } else if (wallMs === this.lastWallMs) {
      // Ties with local only: increment local counter
      counter = this.lastCounter + 1
    } else if (wallMs === remote.wallMs) {
      // Ties with remote only: increment remote counter
      counter = remote.counter + 1
    } else {
      // New wallMs is strictly larger: reset counter
      counter = 0
    }

    this.lastWallMs = wallMs
    this.lastCounter = counter

    return { wallMs, counter, nodeId: this.nodeId }
  }

  /**
   * Compare two timestamps for total ordering.
   *
   * Order: wallMs first, then counter, then nodeId lexicographically.
   * Returns -1 if a < b, 0 if equal, 1 if a > b.
   */
  static compare(a: HLCTimestamp, b: HLCTimestamp): -1 | 0 | 1 {
    if (a.wallMs < b.wallMs) return -1
    if (a.wallMs > b.wallMs) return 1

    if (a.counter < b.counter) return -1
    if (a.counter > b.counter) return 1

    if (a.nodeId < b.nodeId) return -1
    if (a.nodeId > b.nodeId) return 1

    return 0
  }
}
