import type { RunExecutorResult } from './run-worker.js'

export function isStructuredResult(value: unknown): value is RunExecutorResult {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'output' in (value as Record<string, unknown>),
  )
}

/** Narrow an unknown value to a plain object (non-array, non-null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
