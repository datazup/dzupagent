/**
 * Formatting utilities for the DzupAgent Playground.
 *
 * @module format
 */
import type { TraceEvent } from '../types.js'

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string, e.g. "45ms", "1.2s", "2m 3s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/**
 * Format an ISO timestamp as a relative time string.
 *
 * @param isoString - ISO 8601 timestamp
 * @returns Relative time string, e.g. "just now", "5s ago", "2m ago"
 */
export function formatRelativeTime(isoString: string): string {
  try {
    const then = new Date(isoString).getTime()
    if (Number.isNaN(then)) return ''
    const now = Date.now()
    const diffMs = now - then

    if (diffMs < 0) return 'just now'
    if (diffMs < 5_000) return 'just now'
    if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
    return `${Math.floor(diffMs / 86_400_000)}d ago`
  } catch {
    return ''
  }
}

/** Map of trace event types to Tailwind CSS class strings for badges */
const TYPE_COLOR_MAP: Record<TraceEvent['type'], string> = {
  llm: 'bg-pg-accent/15 text-pg-accent',
  tool: 'bg-pg-success/15 text-pg-success',
  memory: 'bg-pg-info/15 text-pg-info',
  guardrail: 'bg-pg-warning/15 text-pg-warning',
  system: 'bg-pg-surface-raised text-pg-text-muted',
}

/**
 * Return Tailwind classes for a trace event type badge.
 *
 * @param type - The trace event type
 * @returns Tailwind class string for background and text color
 */
export function typeColor(type: TraceEvent['type']): string {
  return TYPE_COLOR_MAP[type] ?? 'bg-pg-surface-raised text-pg-text-muted'
}

/** Map of trace event types to CSS color variable references (for inline styles) */
const TYPE_BAR_COLOR_MAP: Record<TraceEvent['type'], string> = {
  llm: 'var(--color-pg-accent)',
  tool: 'var(--color-pg-success)',
  memory: 'var(--color-pg-info)',
  guardrail: 'var(--color-pg-warning)',
  system: 'var(--color-pg-text-muted)',
}

/**
 * Return a CSS color variable reference for a trace event type (for inline styles).
 *
 * @param type - The trace event type
 * @returns CSS variable string
 */
export function typeBarColor(type: TraceEvent['type']): string {
  return TYPE_BAR_COLOR_MAP[type] ?? 'var(--color-pg-text-muted)'
}

/** Map of trace event types to display labels */
const TYPE_ICON_MAP: Record<TraceEvent['type'], string> = {
  llm: 'LLM',
  tool: 'TOOL',
  memory: 'MEM',
  guardrail: 'GUARD',
  system: 'SYS',
}

/**
 * Return a short label for a trace event type.
 *
 * @param type - The trace event type
 * @returns Short label string
 */
export function typeIcon(type: TraceEvent['type']): string {
  return TYPE_ICON_MAP[type] ?? type.toUpperCase()
}
