/**
 * Unified error detection orchestrator --- aggregates errors from multiple
 * detection sources into a single stream with severity classification
 * and cross-error correlation.
 *
 * Sources: stuck_detector, pipeline_stuck, safety_monitor, quality_regression,
 * build_failure, test_failure, timeout, resource_exhaustion.
 *
 * Pure aggregation and classification --- no external dependencies or LLM calls.
 */

export type ErrorSource =
  | 'stuck_detector'
  | 'pipeline_stuck'
  | 'safety_monitor'
  | 'quality_regression'
  | 'build_failure'
  | 'test_failure'
  | 'timeout'
  | 'resource_exhaustion'

export type ErrorSeverity = 'critical' | 'degraded' | 'warning' | 'info'

export interface DetectedError {
  id: string
  source: ErrorSource
  severity: ErrorSeverity
  nodeId?: string
  message: string
  timestamp: Date
  context: Record<string, unknown>
  suggestedRecovery?: string
  correlatedErrors?: string[]
}

export interface ErrorDetectorConfig {
  /** Quality score threshold below which to flag regression (0-1, default: 0.6) */
  qualityRegressionThreshold: number
  /** Time window for error correlation in ms (default: 60000) */
  correlationWindowMs: number
  /** Max errors to keep in history (default: 100) */
  maxHistorySize: number
}

const DEFAULT_CONFIG: ErrorDetectorConfig = {
  qualityRegressionThreshold: 0.6,
  correlationWindowMs: 60_000,
  maxHistorySize: 100,
}

/** Map each error source to a default severity. */
const SOURCE_SEVERITY: Record<ErrorSource, ErrorSeverity> = {
  safety_monitor: 'critical',
  resource_exhaustion: 'critical',
  stuck_detector: 'degraded',
  pipeline_stuck: 'degraded',
  timeout: 'degraded',
  build_failure: 'warning',
  test_failure: 'warning',
  quality_regression: 'warning',
}

/** Map each error source to a default recovery suggestion. */
const SOURCE_RECOVERY: Record<ErrorSource, string> = {
  safety_monitor: 'Halt execution and review safety violation',
  resource_exhaustion: 'Reduce concurrency or increase resource limits',
  stuck_detector: 'Switch strategy or inject a hint to break the loop',
  pipeline_stuck: 'Skip node or switch to fallback strategy',
  timeout: 'Increase timeout or simplify the task',
  build_failure: 'Review build logs and fix compilation errors',
  test_failure: 'Review failing tests and fix regressions',
  quality_regression: 'Revert recent changes and re-evaluate approach',
}

export class ErrorDetectionOrchestrator {
  private history: DetectedError[] = []
  private counter = 0
  private readonly config: ErrorDetectorConfig

  constructor(config?: Partial<ErrorDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Record an error from any source. Auto-classifies severity and correlates. */
  recordError(params: {
    source: ErrorSource
    message: string
    nodeId?: string
    context?: Record<string, unknown>
  }): DetectedError {
    const { source, message, nodeId, context } = params

    const error: DetectedError = {
      id: this.generateId(),
      source,
      severity: SOURCE_SEVERITY[source],
      nodeId,
      message,
      timestamp: new Date(),
      context: context ?? {},
      suggestedRecovery: SOURCE_RECOVERY[source],
      correlatedErrors: [],
    }

    // Find correlated errors (same nodeId within the correlation window)
    if (nodeId) {
      const windowStart = error.timestamp.getTime() - this.config.correlationWindowMs
      const correlated = this.history
        .filter(
          (e) =>
            e.nodeId === nodeId &&
            e.timestamp.getTime() >= windowStart &&
            e.id !== error.id,
        )
        .map((e) => e.id)

      error.correlatedErrors = correlated

      // Back-link: add this error's ID to correlated errors
      for (const existing of this.history) {
        if (correlated.includes(existing.id) && existing.correlatedErrors) {
          existing.correlatedErrors.push(error.id)
        }
      }
    }

    this.pushToHistory(error)
    return error
  }

  /** Record a quality score and check for regression. Returns a DetectedError if regression detected, null otherwise. */
  recordQualityScore(nodeId: string, score: number, baseline?: number): DetectedError | null {
    const effectiveBaseline = baseline ?? 1.0
    const threshold = effectiveBaseline * this.config.qualityRegressionThreshold

    if (score < threshold) {
      return this.recordError({
        source: 'quality_regression',
        message: `Quality score ${score.toFixed(3)} is below threshold ${threshold.toFixed(3)} (baseline: ${effectiveBaseline.toFixed(3)})`,
        nodeId,
        context: { score, baseline: effectiveBaseline, threshold },
      })
    }

    return null
  }

  /** Get all errors within the given time window (defaults to correlationWindowMs). */
  getRecentErrors(windowMs?: number): DetectedError[] {
    const window = windowMs ?? this.config.correlationWindowMs
    const cutoff = Date.now() - window
    return this.history.filter((e) => e.timestamp.getTime() >= cutoff)
  }

  /** Get errors correlated with a specific error. */
  getCorrelatedErrors(errorId: string): DetectedError[] {
    const target = this.history.find((e) => e.id === errorId)
    if (!target || !target.correlatedErrors || target.correlatedErrors.length === 0) {
      return []
    }
    const ids = new Set(target.correlatedErrors)
    return this.history.filter((e) => ids.has(e.id))
  }

  /** Get error frequency by source. */
  getErrorFrequency(): Map<ErrorSource, number> {
    const freq = new Map<ErrorSource, number>()
    for (const error of this.history) {
      freq.set(error.source, (freq.get(error.source) ?? 0) + 1)
    }
    return freq
  }

  /** Get the most severe recent error (within correlation window). */
  getMostSevere(): DetectedError | null {
    if (this.history.length === 0) return null

    const severityOrder: Record<ErrorSeverity, number> = {
      critical: 0,
      degraded: 1,
      warning: 2,
      info: 3,
    }

    const recent = this.getRecentErrors()
    if (recent.length === 0) {
      // Fall back to the entire history if nothing is in the window
      return this.history.reduce((worst, e) =>
        severityOrder[e.severity] < severityOrder[worst.severity] ? e : worst,
      )
    }

    return recent.reduce((worst, e) =>
      severityOrder[e.severity] < severityOrder[worst.severity] ? e : worst,
    )
  }

  /** Clear all error history. */
  reset(): void {
    this.history = []
    this.counter = 0
  }

  private generateId(): string {
    this.counter++
    return `err_${Date.now()}_${this.counter}`
  }

  private pushToHistory(error: DetectedError): void {
    this.history.push(error)
    // Enforce sliding window
    if (this.history.length > this.config.maxHistorySize) {
      this.history.splice(0, this.history.length - this.config.maxHistorySize)
    }
  }
}
