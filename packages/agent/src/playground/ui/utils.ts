/**
 * Shared utility functions for Playground UI components.
 *
 * Extracted from the Vue SFC components so they can be used
 * programmatically without importing the full component.
 *
 * @module playground/ui/utils
 */

import type { TimelineNode } from '../../replay/replay-types.js'
import type { NodeMetrics, ReplaySummary } from '../../replay/replay-inspector.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeStatus = 'error' | 'success' | 'running' | 'pending'
export type ChangeType = 'added' | 'removed' | 'modified' | 'unchanged'

export interface DiffRow {
  key: string
  changeType: ChangeType
  before: unknown
  after: unknown
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

/** Determine the visual status of a timeline node. */
export function getNodeStatus(node: TimelineNode): NodeStatus {
  if (node.isError) return 'error'
  if (node.durationMs !== undefined && node.durationMs > 0) return 'success'
  if (node.type.endsWith(':started') || node.type.includes('running')) return 'running'
  return 'pending'
}

/** Format milliseconds to a human-readable string. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 1000).toFixed(2)}s`
}

/** Format cost in cents to a dollar string. */
export function formatCost(cents: number): string {
  if (cents === 0) return '$0.00'
  return `$${(cents / 100).toFixed(4)}`
}

/** Compute bar width as a percentage string given a duration and max. */
export function barWidthPercent(durationMs: number, maxDuration: number): string {
  const safe = maxDuration || 1
  const pct = Math.max((durationMs / safe) * 100, 2)
  return `${Math.round(pct)}%`
}

/** Find the maximum duration across a set of timeline nodes. */
export function getMaxDuration(nodes: TimelineNode[]): number {
  let max = 0
  for (const node of nodes) {
    const d = node.durationMs ?? node.latencyMs ?? 0
    if (d > max) max = d
  }
  return max || 1
}

/** Compute total pipeline duration from first to last node timestamp. */
export function getTotalDuration(nodes: TimelineNode[]): number {
  if (nodes.length < 2) return 0
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (!first || !last) return 0
  return last.timestamp - first.timestamp
}

// ---------------------------------------------------------------------------
// State diff helpers
// ---------------------------------------------------------------------------

/** Deep equality check for two values. */
export function deepEqual(a: unknown, b: unknown): boolean {
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

/** Compute diff rows between two state snapshots. */
export function computeDiffRows(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DiffRow[] {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])
  const rows: DiffRow[] = []

  for (const key of allKeys) {
    const inBefore = key in before
    const inAfter = key in after

    if (inBefore && !inAfter) {
      rows.push({ key, changeType: 'removed', before: before[key], after: undefined })
    } else if (!inBefore && inAfter) {
      rows.push({ key, changeType: 'added', before: undefined, after: after[key] })
    } else if (deepEqual(before[key], after[key])) {
      rows.push({ key, changeType: 'unchanged', before: before[key], after: after[key] })
    } else {
      rows.push({ key, changeType: 'modified', before: before[key], after: after[key] })
    }
  }

  const order: Record<ChangeType, number> = { added: 0, modified: 1, removed: 2, unchanged: 3 }
  rows.sort((a, b) => order[a.changeType] - order[b.changeType] || a.key.localeCompare(b.key))

  return rows
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

/** Count nodes that had at least one error. */
export function getFailedNodeCount(summary: ReplaySummary): number {
  let count = 0
  for (const metrics of Object.values(summary.nodeMetrics)) {
    if ((metrics as NodeMetrics).errorCount > 0) count++
  }
  return count
}

/** Get top N bottleneck nodes sorted by duration descending. */
export function getBottleneckNodes(summary: ReplaySummary, limit = 3): NodeMetrics[] {
  return (Object.values(summary.nodeMetrics) as NodeMetrics[])
    .filter(m => m.totalDurationMs > 0)
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
    .slice(0, limit)
}

/** Get error-related event types from summary, sorted by count descending. */
export function getErrorEventTypes(summary: ReplaySummary): Array<{ type: string; count: number }> {
  const types: Array<{ type: string; count: number }> = []
  for (const [type, count] of Object.entries(summary.eventTypeCounts)) {
    if (type.endsWith(':failed') || type.endsWith(':error') || type.includes('retry') || type.includes('recovery')) {
      types.push({ type, count })
    }
  }
  types.sort((a, b) => b.count - a.count)
  return types
}

/** Format any value as a display-friendly string. */
export function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
