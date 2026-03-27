/**
 * Vector clock for causal ordering in distributed systems.
 *
 * Each agent maintains its own counter; clocks are compared element-wise.
 * Instances are immutable — all mutation methods return a new VectorClock.
 */

export type VectorClockComparison = 'before' | 'after' | 'concurrent' | 'equal'

export class VectorClock {
  private readonly clocks: ReadonlyMap<string, number>

  constructor(initial?: Record<string, number> | Map<string, number>) {
    if (initial instanceof Map) {
      this.clocks = new Map(initial)
    } else if (initial !== undefined) {
      this.clocks = new Map(Object.entries(initial))
    } else {
      this.clocks = new Map()
    }
  }

  /** Increment this agent's counter. Returns a new VectorClock instance. */
  increment(agentId: string): VectorClock {
    const next = new Map(this.clocks)
    next.set(agentId, (this.clocks.get(agentId) ?? 0) + 1)
    return new VectorClock(next)
  }

  /** Get counter for an agent. Returns 0 if the agent has no entry. */
  get(agentId: string): number {
    return this.clocks.get(agentId) ?? 0
  }

  /** Merge two clocks (element-wise max). Returns a new VectorClock. */
  merge(other: VectorClock): VectorClock {
    const merged = new Map(this.clocks)
    for (const [agentId, counter] of other.clocks) {
      merged.set(agentId, Math.max(merged.get(agentId) ?? 0, counter))
    }
    return new VectorClock(merged)
  }

  /**
   * Compare this clock with another.
   *
   * - `equal`:      all counters identical
   * - `before`:     all counters <= other, at least one <
   * - `after`:      all counters >= other, at least one >
   * - `concurrent`: neither before nor after (some greater, some less)
   */
  compare(other: VectorClock): VectorClockComparison {
    // Collect the union of all agent IDs
    const allAgents = new Set<string>([...this.clocks.keys(), ...other.clocks.keys()])

    let hasLess = false
    let hasGreater = false

    for (const agentId of allAgents) {
      const a = this.clocks.get(agentId) ?? 0
      const b = other.clocks.get(agentId) ?? 0

      if (a < b) hasLess = true
      if (a > b) hasGreater = true

      // Early exit: if we've found both less and greater, it's concurrent
      if (hasLess && hasGreater) return 'concurrent'
    }

    if (!hasLess && !hasGreater) return 'equal'
    if (hasLess && !hasGreater) return 'before'
    // hasGreater && !hasLess
    return 'after'
  }

  /** Serialize to plain object for storage. */
  toJSON(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const [agentId, counter] of this.clocks) {
      result[agentId] = counter
    }
    return result
  }

  /** Deserialize from a plain object. */
  static fromJSON(data: Record<string, number>): VectorClock {
    return new VectorClock(data)
  }

  /** Number of agents tracked by this clock. */
  get size(): number {
    return this.clocks.size
  }
}
