/**
 * Shared utility functions for framework-internal playground trace UI helpers.
 *
 * Vue SFC source is not maintained in this package. These helpers remain
 * rendering-independent so source-internal maintenance tests can validate trace
 * formatting, tone mapping, and class composition without publishing a product
 * UI surface.
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
export type TraceTone = 'danger' | 'success' | 'warning' | 'neutral'
export type TraceDensity = 'compact' | 'default'

export interface DiffRow {
  key: string
  changeType: ChangeType
  before: unknown
  after: unknown
}

export interface TraceToneStyles {
  badge: string
  dot: string
  bar: string
  text: string
  textStrong: string
  panel: string
  borderLeft: string
}

export interface TraceDensityStyles {
  sectionGap: string
  detailGrid: string
  rowButton: string
  rowGap: string
  rowPadding: string
  rowRadius: string
  labelColumn: string
  durationColumn: string
  valueColumn: string
  metricTile: string
  badge: string
  badgeText: string
  captionText: string
  codeBlock: string
  codeText: string
  tableCell: string
}

export interface TraceInteractionStyles {
  focusRing: string
  selectedSurface: string
  selectedBorder: string
}

export interface TraceUiHostContract {
  /**
   * Tailwind must be configured to activate dark variants from a `.dark`
   * class on a host ancestor, for example `<html class="dark">`.
   */
  darkMode: 'class'
  requiredHostClass: 'dark'
  appliesTo: readonly string[]
}

// ---------------------------------------------------------------------------
// Trace UI style adapter
// ---------------------------------------------------------------------------

/**
 * Centralized visual primitives for the framework-internal trace UI.
 *
 * Playground UI is not a public design-system surface, but keeping semantic
 * treatments behind this small adapter preserves a narrow utility seam for a
 * future app-owned renderer or design-system handoff.
 *
 * Dark-mode styling intentionally uses Tailwind `dark:` variants. Hosts that
 * reuse these internal class strings must satisfy `traceUiHostContract` by
 * enabling class-based dark mode and toggling a `.dark` class on an ancestor.
 */
export const traceUiHostContract: TraceUiHostContract = {
  darkMode: 'class',
  requiredHostClass: 'dark',
  appliesTo: [
    'status tone',
    'surface',
    'text',
    'divider',
    'selected',
    'interactive',
  ],
}

export const traceInteractionStyles: TraceInteractionStyles = {
  focusRing: 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500',
  selectedSurface: 'bg-blue-50 dark:bg-blue-950',
  selectedBorder: 'border-blue-500 dark:border-blue-400',
}

export const traceUiStyles = {
  panel: 'rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900',
  panelMuted: 'rounded-md bg-gray-50 dark:bg-gray-800',
  panelSubtle: 'rounded-md border border-gray-200 dark:border-gray-700',
  tableHeader: 'border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800',
  tableRow: 'border-b border-gray-100 last:border-b-0 dark:border-gray-800',
  divider: 'border-gray-200 dark:border-gray-700',
  dividerSubtle: 'border-gray-100 dark:border-gray-800',
  focusRing: traceInteractionStyles.focusRing,
  selectedSurface: traceInteractionStyles.selectedSurface,
  selectedBorder: traceInteractionStyles.selectedBorder,
  selected: `${traceInteractionStyles.selectedBorder} ${traceInteractionStyles.selectedSurface}`,
  interactive: 'border-transparent hover:border-gray-200 hover:bg-gray-50 dark:hover:border-gray-700 dark:hover:bg-gray-900',
  interactiveMuted: 'hover:bg-gray-50 dark:hover:bg-gray-800',
  track: 'bg-gray-100 dark:bg-gray-800',
  textPrimary: 'text-gray-900 dark:text-gray-100',
  textSecondary: 'text-gray-800 dark:text-gray-200',
  textMuted: 'text-gray-500 dark:text-gray-400',
  textSubtle: 'text-gray-600 dark:text-gray-400',
  textDisabled: 'text-gray-400 dark:text-gray-500',
  badgeNeutral: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
} as const

/**
 * Named trace density slots for internal renderers.
 *
 * The default values preserve the previous Vue template defaults called out by
 * the audit (`gap-5`, `gap-4 p-4`, `gap-3 rounded-md px-3 py-2`, fixed trace
 * columns, and compact caption text) while giving future renderers one place to
 * switch to a compact mode.
 */
export const traceDensityStyles: Record<TraceDensity, TraceDensityStyles> = {
  compact: {
    sectionGap: 'gap-3',
    detailGrid: 'gap-3 p-3',
    rowButton: 'gap-2 rounded px-2 py-1.5',
    rowGap: 'gap-2',
    rowPadding: 'px-2 py-1.5',
    rowRadius: 'rounded',
    labelColumn: 'w-28',
    durationColumn: 'w-14',
    valueColumn: 'w-24',
    metricTile: 'rounded p-2',
    badge: 'rounded px-1.5 py-0.5',
    badgeText: 'text-[10px] font-medium',
    captionText: 'text-[10px] uppercase',
    codeBlock: 'rounded p-2 text-[11px]',
    codeText: 'text-[11px]',
    tableCell: 'px-2 py-1.5',
  },
  default: {
    sectionGap: 'gap-5',
    detailGrid: 'gap-4 p-4',
    rowButton: 'gap-3 rounded-md px-3 py-2',
    rowGap: 'gap-3',
    rowPadding: 'px-3 py-2',
    rowRadius: 'rounded-md',
    labelColumn: 'w-36',
    durationColumn: 'w-16',
    valueColumn: 'w-32',
    metricTile: 'rounded-md p-3',
    badge: 'rounded px-2 py-0.5',
    badgeText: 'text-[11px] font-medium',
    captionText: 'text-[10px] uppercase',
    codeBlock: 'rounded-md p-3 text-xs',
    codeText: 'text-xs',
    tableCell: 'px-3 py-2',
  },
}

export const traceToneStyles: Record<TraceTone, TraceToneStyles> = {
  danger: {
    badge: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    dot: 'bg-red-500',
    bar: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
    textStrong: 'text-red-800 dark:text-red-200',
    panel: 'border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950',
    borderLeft: 'border-l-red-500',
  },
  success: {
    badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    textStrong: 'text-emerald-800 dark:text-emerald-200',
    panel: 'border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950',
    borderLeft: 'border-l-emerald-500',
  },
  warning: {
    badge: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    dot: 'bg-yellow-500',
    bar: 'bg-yellow-500',
    text: 'text-yellow-600 dark:text-yellow-400',
    textStrong: 'text-yellow-800 dark:text-yellow-200',
    panel: 'border border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950',
    borderLeft: 'border-l-yellow-500',
  },
  neutral: {
    badge: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    dot: 'bg-gray-400',
    bar: 'bg-gray-400',
    text: 'text-gray-600 dark:text-gray-400',
    textStrong: 'text-gray-900 dark:text-gray-100',
    panel: 'border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800',
    borderLeft: 'border-l-transparent',
  },
}

export function getTraceStatusTone(status: NodeStatus): TraceTone {
  switch (status) {
    case 'error':
      return 'danger'
    case 'success':
      return 'success'
    case 'running':
      return 'warning'
    case 'pending':
      return 'neutral'
  }
}

export function getTraceStatusStyles(status: NodeStatus): TraceToneStyles {
  return traceToneStyles[getTraceStatusTone(status)]
}

export function getTraceChangeTone(changeType: ChangeType): TraceTone {
  switch (changeType) {
    case 'added':
      return 'success'
    case 'removed':
      return 'danger'
    case 'modified':
      return 'warning'
    case 'unchanged':
      return 'neutral'
  }
}

export function getTraceChangeStyles(changeType: ChangeType): TraceToneStyles {
  return traceToneStyles[getTraceChangeTone(changeType)]
}

export function getTraceDensityStyles(density: TraceDensity = 'default'): TraceDensityStyles {
  return traceDensityStyles[density]
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
