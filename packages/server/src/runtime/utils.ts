import type { RunExecutorResult } from './run-worker.js'

export function isStructuredResult(value: unknown): value is RunExecutorResult {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'output' in (value as Record<string, unknown>),
  )
}
