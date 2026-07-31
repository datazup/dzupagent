import type { Table } from 'apache-arrow'
import type { FrameDelta } from '@dzupagent/memory-ipc'
import { computeFrameDeltaDetailed } from '@dzupagent/memory-ipc'

export type SnapshotInvalidationReason =
  | 'no-snapshot'
  | 'no-baseline-frame'
  | 'significant-delta'
  | 'comparison-failure'
  | 'reuse'

export interface SnapshotInvalidationResult {
  shouldInvalidate: boolean
  reason: SnapshotInvalidationReason
  /** Saturating streak; never grows beyond the configured telemetry threshold. */
  consecutiveComparisonFailures: number
  /** True only for the call that first reaches the configured telemetry threshold. */
  comparisonFailureTelemetryTriggered?: boolean
  delta?: FrameDelta
}

export interface SnapshotComparisonFailureTelemetry {
  reason: 'comparison-failure'
  consecutiveFailures: number
  threshold: number
}

export interface FrozenSnapshotOptions {
  /** Repeated comparison failures required before telemetry fires (default: 3). */
  comparisonFailureTelemetryThreshold?: number
  /** Fires once when a comparison-failure streak reaches the threshold. */
  onRepeatedComparisonFailure?: (
    event: SnapshotComparisonFailureTelemetry,
  ) => void
}

/**
 * Captures memory/context at session start and prevents mid-session reloads,
 * preserving a stable prompt-cache prefix.
 */
export class FrozenSnapshot {
  private frozen: string | null = null
  private isFrozen = false
  private frozenFrame: unknown = null
  private unavailableReason: string | null = null
  private readonly comparisonFailureTelemetryThreshold: number
  private readonly onRepeatedComparisonFailure?: FrozenSnapshotOptions['onRepeatedComparisonFailure']
  private comparisonFailureStreak = 0
  private comparisonFailureReported = false

  constructor(options: FrozenSnapshotOptions = {}) {
    const threshold = options.comparisonFailureTelemetryThreshold ?? 3
    if (!Number.isInteger(threshold) || threshold <= 0) {
      throw new Error(
        "FrozenSnapshot: 'comparisonFailureTelemetryThreshold' must be a positive integer",
      )
    }
    this.comparisonFailureTelemetryThreshold = threshold
    this.onRepeatedComparisonFailure = options.onRepeatedComparisonFailure
  }

  /** Capture the current context as the frozen snapshot, optionally storing an Arrow frame. */
  freeze(context: string, frame?: unknown): void {
    this.frozen = context
    this.isFrozen = true
    this.frozenFrame = frame ?? null
    this.unavailableReason = null
    this.resetComparisonFailures()
  }

  /** Mark a snapshot as built while its source was unreachable. */
  markSourceUnavailable(reason: string): void {
    this.unavailableReason = reason
  }

  /** Why the snapshot source could not be read, or null after a successful read. */
  sourceUnavailable(): string | null {
    return this.unavailableReason
  }

  /** Get the frozen context, or null if not frozen. */
  get(): string | null {
    return this.frozen
  }

  /** Check if a snapshot has been frozen. */
  isActive(): boolean {
    return this.isFrozen
  }

  /** Preserve the conservative legacy boolean invalidation contract. */
  shouldInvalidate(newFrame: unknown): boolean {
    return this.shouldInvalidateDetailed(newFrame).shouldInvalidate
  }

  /** Explain the snapshot reuse decision and bounded comparison-failure streak. */
  shouldInvalidateDetailed(newFrame: unknown): SnapshotInvalidationResult {
    if (!this.isFrozen) {
      this.resetComparisonFailures()
      return {
        shouldInvalidate: true,
        reason: 'no-snapshot',
        consecutiveComparisonFailures: 0,
      }
    }
    if (this.frozenFrame === null) {
      this.resetComparisonFailures()
      return {
        shouldInvalidate: true,
        reason: 'no-baseline-frame',
        consecutiveComparisonFailures: 0,
      }
    }

    try {
      const comparison = computeFrameDeltaDetailed(
        this.frozenFrame as Table,
        newFrame as Table,
      )
      if (!comparison.ok) return this.recordComparisonFailure(comparison.delta)

      this.resetComparisonFailures()
      const { delta } = comparison
      return {
        shouldInvalidate: delta.shouldRefreeze,
        reason: delta.shouldRefreeze ? 'significant-delta' : 'reuse',
        consecutiveComparisonFailures: 0,
        delta,
      }
    } catch {
      return this.recordComparisonFailure()
    }
  }

  private recordComparisonFailure(
    delta?: FrameDelta,
  ): SnapshotInvalidationResult {
    this.comparisonFailureStreak = Math.min(
      this.comparisonFailureStreak + 1,
      this.comparisonFailureTelemetryThreshold,
    )
    let telemetryTriggered = false
    if (
      !this.comparisonFailureReported &&
      this.comparisonFailureStreak >= this.comparisonFailureTelemetryThreshold
    ) {
      this.comparisonFailureReported = true
      telemetryTriggered = true
      try {
        this.onRepeatedComparisonFailure?.({
          reason: 'comparison-failure',
          consecutiveFailures: this.comparisonFailureStreak,
          threshold: this.comparisonFailureTelemetryThreshold,
        })
      } catch {
        // Observability must not affect the conservative invalidation decision.
      }
    }
    return {
      shouldInvalidate: true,
      reason: 'comparison-failure',
      consecutiveComparisonFailures: this.comparisonFailureStreak,
      ...(telemetryTriggered
        ? { comparisonFailureTelemetryTriggered: true }
        : {}),
      ...(delta ? { delta } : {}),
    }
  }

  private resetComparisonFailures(): void {
    this.comparisonFailureStreak = 0
    this.comparisonFailureReported = false
  }

  /** Clear the frozen snapshot for the next session. */
  thaw(): void {
    this.frozen = null
    this.isFrozen = false
    this.frozenFrame = null
    this.unavailableReason = null
    this.resetComparisonFailures()
  }
}
