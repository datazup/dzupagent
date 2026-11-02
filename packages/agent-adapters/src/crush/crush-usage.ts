/**
 * Crush 0.98.1 stores latest context token counters, not cumulative run usage.
 * Native multi-step qualification confirms that summing these counters
 * undercounts model calls. Cost cannot be represented independently by the
 * normalized TokenUsage contract, whose input/output totals are required.
 *
 * Retain these exports for compatibility; no unsupported totals are emitted.
 */
import type { TokenUsage } from '../types.js'

export function isCrushUsageReaderAvailable(): boolean { return false }

export function readCrushUsage(_dataDir: string | undefined): TokenUsage | undefined {
  return undefined
}
