/**
 * ReplayInspector — analyzes replay sessions to produce timeline
 * visualizations, state diffs, and execution metrics.
 *
 * @module replay/replay-inspector
 */

import type {
  ReplayEvent,
  ReplaySession,
  StateDiffEntry,
  TimelineNode,
  TimelineData,
} from './replay-types.js'

// ---------------------------------------------------------------------------
// ReplayInspector
// ---------------------------------------------------------------------------

/**
 * Inspects a replay session to produce visualization data, state diffs,
 * and execution summaries.
 *
 * ```ts
 * const inspector = new ReplayInspector(session)
 * const timeline = inspector.getTimeline()
 * const diffs = inspector.getStateDiff(5, 6)
 * ```
 */
export class ReplayInspector {
  private readonly session: ReplaySession

  constructor(session: ReplaySession) {
    this.session = session
  }

  // ---------------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------------

  /**
   * Generate a complete timeline visualization of the replay session.
   * This data structure is designed for UI consumption (JSON-serializable).
   */
  getTimeline(): TimelineData {
    const nodes: TimelineNode[] = []
    let totalTokens = 0
    let totalCostCents = 0
    let errorCount = 0
    let recoveryCount = 0
    const nodeIdSet = new Set<string>()

    for (const event of this.session.events) {
      const isError = isErrorEvent(event)
      const isRecovery = isRecoveryEvent(event)

      if (isError) errorCount++
      if (isRecovery) recoveryCount++

      // Accumulate tokens and cost from event data
      const eventTokens = extractNumber(event.data, 'tokensUsed') ??
        extractNumber(event.data, 'tokenCount') ?? 0
      const eventCost = extractNumber(event.data, 'costCents') ?? 0

      totalTokens += eventTokens
      totalCostCents += eventCost

      if (event.nodeId) {
        nodeIdSet.add(event.nodeId)
      }

      const node: TimelineNode = {
        index: event.index,
        timestamp: event.timestamp,
        type: event.type,
        nodeId: event.nodeId,
        durationMs: extractNumber(event.data, 'durationMs'),
        isError,
        tokenUsage: totalTokens,
        costCents: totalCostCents,
        latencyMs: extractNumber(event.data, 'durationMs'),
      }

      nodes.push(node)
    }

    const events = this.session.events
    const totalDurationMs = events.length >= 2
      ? events[events.length - 1]!.timestamp - events[0]!.timestamp
      : 0

    return {
      nodes,
      totalDurationMs,
      totalTokens,
      totalCostCents,
      errorCount,
      recoveryCount,
      nodeIds: [...nodeIdSet],
    }
  }

  // ---------------------------------------------------------------------------
  // State diffs
  // ---------------------------------------------------------------------------

  /**
   * Compute the state diff between two event indices.
   *
   * Requires that at least one of the events (or a prior event) has
   * a state snapshot. Returns an empty array if no snapshots are available
   * to compare.
   */
  getStateDiff(fromIndex: number, toIndex: number): StateDiffEntry[] {
    const fromState = this.findNearestSnapshot(fromIndex)
    const toState = this.findNearestSnapshot(toIndex)

    if (!fromState || !toState) return []

    return computeDiff(fromState, toState)
  }

  /**
   * Get the state snapshot at or nearest before a given index.
   */
  getStateAt(index: number): Record<string, unknown> | undefined {
    return this.findNearestSnapshot(index)
  }

  // ---------------------------------------------------------------------------
  // Event filtering and search
  // ---------------------------------------------------------------------------

  /**
   * Find all events matching a given type pattern.
   */
  findEventsByType(typePattern: string): ReplayEvent[] {
    return this.session.events.filter(e => {
      if (typePattern.endsWith('*')) {
        return e.type.startsWith(typePattern.slice(0, -1))
      }
      return e.type === typePattern
    })
  }

  /**
   * Find all events associated with a specific node.
   */
  findEventsByNode(nodeId: string): ReplayEvent[] {
    return this.session.events.filter(e => e.nodeId === nodeId)
  }

  /**
   * Find all error events in the session.
   */
  findErrors(): ReplayEvent[] {
    return this.session.events.filter(isErrorEvent)
  }

  /**
   * Find all recovery/retry events.
   */
  findRecoveryAttempts(): ReplayEvent[] {
    return this.session.events.filter(isRecoveryEvent)
  }

  // ---------------------------------------------------------------------------
  // Per-node metrics
  // ---------------------------------------------------------------------------

  /**
   * Compute aggregate metrics per node ID.
   */
  getNodeMetrics(): Map<string, NodeMetrics> {
    const metrics = new Map<string, NodeMetrics>()

    for (const event of this.session.events) {
      if (!event.nodeId) continue

      let m = metrics.get(event.nodeId)
      if (!m) {
        m = {
          nodeId: event.nodeId,
          eventCount: 0,
          totalDurationMs: 0,
          errorCount: 0,
          retryCount: 0,
        }
        metrics.set(event.nodeId, m)
      }

      m.eventCount++

      const duration = extractNumber(event.data, 'durationMs')
      if (duration !== undefined) {
        m.totalDurationMs += duration
      }

      if (isErrorEvent(event)) m.errorCount++
      if (isRecoveryEvent(event)) m.retryCount++
    }

    return metrics
  }

  /**
   * Get a summary of the replay session.
   */
  getSummary(): ReplaySummary {
    const timeline = this.getTimeline()
    const nodeMetrics = this.getNodeMetrics()

    return {
      runId: this.session.runId,
      totalEvents: this.session.events.length,
      totalDurationMs: timeline.totalDurationMs,
      totalTokens: timeline.totalTokens,
      totalCostCents: timeline.totalCostCents,
      errorCount: timeline.errorCount,
      recoveryCount: timeline.recoveryCount,
      nodeCount: timeline.nodeIds.length,
      nodeMetrics: Object.fromEntries(nodeMetrics),
      eventTypeCounts: this.computeEventTypeCounts(),
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private findNearestSnapshot(index: number): Record<string, unknown> | undefined {
    const clampedIndex = Math.min(index, this.session.events.length - 1)
    for (let i = clampedIndex; i >= 0; i--) {
      const snapshot = this.session.events[i]?.stateSnapshot
      if (snapshot) {
        return structuredClone(snapshot)
      }
    }
    return undefined
  }

  private computeEventTypeCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const event of this.session.events) {
      counts[event.type] = (counts[event.type] ?? 0) + 1
    }
    return counts
  }
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * Aggregate metrics for a single node in the replay.
 */
export interface NodeMetrics {
  nodeId: string
  eventCount: number
  totalDurationMs: number
  errorCount: number
  retryCount: number
}

/**
 * High-level summary of a replay session.
 */
export interface ReplaySummary {
  runId: string
  totalEvents: number
  totalDurationMs: number
  totalTokens: number
  totalCostCents: number
  errorCount: number
  recoveryCount: number
  nodeCount: number
  nodeMetrics: Record<string, NodeMetrics>
  eventTypeCounts: Record<string, number>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isErrorEvent(event: ReplayEvent): boolean {
  return (
    event.type.endsWith(':failed') ||
    event.type.endsWith(':error') ||
    event.data['error'] !== undefined
  )
}

function isRecoveryEvent(event: ReplayEvent): boolean {
  return (
    event.type.includes('retry') ||
    event.type.includes('recovery') ||
    event.type.includes('stuck_detected')
  )
}

function extractNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key]
  return typeof value === 'number' ? value : undefined
}

// ---------------------------------------------------------------------------
// State diff computation
// ---------------------------------------------------------------------------

/**
 * Compute a flat diff between two state objects.
 * Only compares top-level keys (deep changes are shown as modified).
 */
function computeDiff(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): StateDiffEntry[] {
  const entries: StateDiffEntry[] = []
  const allKeys = new Set([...Object.keys(from), ...Object.keys(to)])

  for (const key of allKeys) {
    const inFrom = key in from
    const inTo = key in to

    if (!inFrom && inTo) {
      entries.push({ path: key, current: to[key], changeType: 'added' })
    } else if (inFrom && !inTo) {
      entries.push({ path: key, previous: from[key], changeType: 'removed' })
    } else if (inFrom && inTo) {
      if (!valuesEqual(from[key], to[key])) {
        entries.push({
          path: key,
          previous: from[key],
          current: to[key],
          changeType: 'modified',
        })
      }
    }
  }

  return entries
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
