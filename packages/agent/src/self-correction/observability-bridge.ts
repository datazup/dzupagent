/**
 * Observability correction bridge --- analyzes OTel-style metrics and
 * generates actionable correction signals.
 *
 * Receives metric recordings (latency, cost, error rate, token budget)
 * and checks them against configurable thresholds. Emits typed correction
 * signals with suggested remediation actions.
 *
 * Pure threshold comparison and sliding-window logic --- no external
 * dependencies or OTel SDK imports.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type CorrectionSignalType =
  | 'latency_spike'
  | 'cost_overrun'
  | 'error_rate_high'
  | 'quality_drop'
  | 'token_budget_warning'

export type SignalSeverity = 'info' | 'warning' | 'critical'

export interface CorrectionSignal {
  id: string
  type: CorrectionSignalType
  severity: SignalSeverity
  nodeId?: string
  message: string
  details: Record<string, unknown>
  suggestedAction: string
  timestamp: Date
}

export interface ObservabilityThresholds {
  /** Latency threshold in ms (default: 30000 for warning, 60000 for critical) */
  latencyWarnMs: number
  latencyCriticalMs: number
  /** Cost per node in cents (default: 50 for warning, 200 for critical) */
  costWarnCents: number
  costCriticalCents: number
  /** Error rate in window (default: 0.3 for warning, 0.5 for critical) */
  errorRateWarn: number
  errorRateCritical: number
  /** Token budget usage ratio (default: 0.7 for warning, 0.9 for critical) */
  tokenBudgetWarn: number
  tokenBudgetCritical: number
}

export interface ObservabilityBridgeConfig {
  thresholds: ObservabilityThresholds
  /** Max signals to keep (default: 50) */
  maxSignals: number
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_THRESHOLDS: ObservabilityThresholds = {
  latencyWarnMs: 30_000,
  latencyCriticalMs: 60_000,
  costWarnCents: 50,
  costCriticalCents: 200,
  errorRateWarn: 0.3,
  errorRateCritical: 0.5,
  tokenBudgetWarn: 0.7,
  tokenBudgetCritical: 0.9,
}

const DEFAULT_CONFIG: ObservabilityBridgeConfig = {
  thresholds: DEFAULT_THRESHOLDS,
  maxSignals: 50,
}

/** Sliding window size per node for error rate calculation. */
const ERROR_WINDOW_SIZE = 10

/** Suggested actions keyed by signal type. */
const SUGGESTED_ACTIONS: Record<CorrectionSignalType, string> = {
  latency_spike: 'Reduce context window or switch to faster model',
  cost_overrun: 'Switch to cheaper model for this node',
  error_rate_high: 'Enable reflection loop or switch strategy',
  quality_drop: 'Increase max iterations or add validation',
  token_budget_warning: 'Compress context or reduce scope',
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

export class ObservabilityCorrectionBridge {
  private signals: CorrectionSignal[] = []
  private counter = 0
  /** Per-node sliding window of success/failure booleans. */
  private nodeSuccessWindow = new Map<string, boolean[]>()
  private readonly config: ObservabilityBridgeConfig

  constructor(config?: Partial<ObservabilityBridgeConfig>) {
    this.config = {
      maxSignals: config?.maxSignals ?? DEFAULT_CONFIG.maxSignals,
      thresholds: { ...DEFAULT_THRESHOLDS, ...config?.thresholds },
    }
  }

  /**
   * Record a node execution metric and check all thresholds.
   * Returns any correction signals that were generated.
   */
  recordNodeMetric(params: {
    nodeId: string
    durationMs: number
    costCents: number
    tokenUsage: { input: number; output: number; budget: number }
    success: boolean
  }): CorrectionSignal[] {
    const { nodeId, durationMs, costCents, tokenUsage, success } = params
    const t = this.config.thresholds
    const generated: CorrectionSignal[] = []

    // --- Latency ---
    if (durationMs >= t.latencyCriticalMs) {
      generated.push(
        this.createSignal('latency_spike', 'critical', nodeId, {
          durationMs,
          threshold: t.latencyCriticalMs,
        }),
      )
    } else if (durationMs >= t.latencyWarnMs) {
      generated.push(
        this.createSignal('latency_spike', 'warning', nodeId, {
          durationMs,
          threshold: t.latencyWarnMs,
        }),
      )
    }

    // --- Cost ---
    if (costCents >= t.costCriticalCents) {
      generated.push(
        this.createSignal('cost_overrun', 'critical', nodeId, {
          costCents,
          threshold: t.costCriticalCents,
        }),
      )
    } else if (costCents >= t.costWarnCents) {
      generated.push(
        this.createSignal('cost_overrun', 'warning', nodeId, {
          costCents,
          threshold: t.costWarnCents,
        }),
      )
    }

    // --- Token budget ---
    const totalTokens = tokenUsage.input + tokenUsage.output
    const budgetRatio = tokenUsage.budget > 0 ? totalTokens / tokenUsage.budget : 0

    if (budgetRatio >= t.tokenBudgetCritical) {
      generated.push(
        this.createSignal('token_budget_warning', 'critical', nodeId, {
          totalTokens,
          budget: tokenUsage.budget,
          ratio: budgetRatio,
          threshold: t.tokenBudgetCritical,
        }),
      )
    } else if (budgetRatio >= t.tokenBudgetWarn) {
      generated.push(
        this.createSignal('token_budget_warning', 'warning', nodeId, {
          totalTokens,
          budget: tokenUsage.budget,
          ratio: budgetRatio,
          threshold: t.tokenBudgetWarn,
        }),
      )
    }

    // --- Error rate (sliding window) ---
    this.pushSuccessWindow(nodeId, success)
    const errorRate = this.getErrorRate(nodeId)

    if (errorRate >= t.errorRateCritical) {
      generated.push(
        this.createSignal('error_rate_high', 'critical', nodeId, {
          errorRate,
          threshold: t.errorRateCritical,
          windowSize: this.getWindowSize(nodeId),
        }),
      )
    } else if (errorRate >= t.errorRateWarn) {
      generated.push(
        this.createSignal('error_rate_high', 'warning', nodeId, {
          errorRate,
          threshold: t.errorRateWarn,
          windowSize: this.getWindowSize(nodeId),
        }),
      )
    }

    return generated
  }

  /** Get all signals since last reset. */
  getSignals(): CorrectionSignal[] {
    return [...this.signals]
  }

  /** Get signals for a specific node. */
  getNodeSignals(nodeId: string): CorrectionSignal[] {
    return this.signals.filter((s) => s.nodeId === nodeId)
  }

  /** Get signal counts by type. */
  getSignalCounts(): Map<CorrectionSignalType, number> {
    const counts = new Map<CorrectionSignalType, number>()
    for (const signal of this.signals) {
      counts.set(signal.type, (counts.get(signal.type) ?? 0) + 1)
    }
    return counts
  }

  /** Check if any critical signals exist. */
  hasCriticalSignals(): boolean {
    return this.signals.some((s) => s.severity === 'critical')
  }

  /** Generate a markdown summary of all correction signals grouped by severity. */
  summarize(): string {
    if (this.signals.length === 0) {
      return 'No correction signals recorded.'
    }

    const bySeverity = new Map<SignalSeverity, CorrectionSignal[]>()
    for (const signal of this.signals) {
      const group = bySeverity.get(signal.severity) ?? []
      group.push(signal)
      bySeverity.set(signal.severity, group)
    }

    const lines: string[] = [`# Correction Signal Summary (${this.signals.length} total)`, '']

    // Ordered from most severe to least
    const order: SignalSeverity[] = ['critical', 'warning', 'info']
    for (const severity of order) {
      const group = bySeverity.get(severity)
      if (!group || group.length === 0) continue

      lines.push(`## ${severity.toUpperCase()} (${group.length})`)
      lines.push('')
      for (const signal of group) {
        const node = signal.nodeId ? ` [${signal.nodeId}]` : ''
        lines.push(`- **${signal.type}**${node}: ${signal.message}`)
        lines.push(`  - Action: ${signal.suggestedAction}`)
      }
      lines.push('')
    }

    return lines.join('\n').trimEnd()
  }

  /** Reset all signal history and per-node state. */
  reset(): void {
    this.signals = []
    this.counter = 0
    this.nodeSuccessWindow.clear()
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private createSignal(
    type: CorrectionSignalType,
    severity: SignalSeverity,
    nodeId: string,
    details: Record<string, unknown>,
  ): CorrectionSignal {
    this.counter++
    const message = this.buildMessage(type, severity, nodeId, details)
    const signal: CorrectionSignal = {
      id: `sig_${Date.now()}_${this.counter}`,
      type,
      severity,
      nodeId,
      message,
      details,
      suggestedAction: SUGGESTED_ACTIONS[type],
      timestamp: new Date(),
    }

    this.signals.push(signal)
    // Enforce max signals
    if (this.signals.length > this.config.maxSignals) {
      this.signals.splice(0, this.signals.length - this.config.maxSignals)
    }

    return signal
  }

  private buildMessage(
    type: CorrectionSignalType,
    severity: SignalSeverity,
    nodeId: string,
    details: Record<string, unknown>,
  ): string {
    switch (type) {
      case 'latency_spike':
        return `Node "${nodeId}" ${severity} latency: ${details['durationMs']}ms (threshold: ${details['threshold']}ms)`
      case 'cost_overrun':
        return `Node "${nodeId}" ${severity} cost: ${details['costCents']}c (threshold: ${details['threshold']}c)`
      case 'error_rate_high':
        return `Node "${nodeId}" error rate ${((details['errorRate'] as number) * 100).toFixed(0)}% exceeds ${severity} threshold`
      case 'token_budget_warning':
        return `Node "${nodeId}" token usage at ${((details['ratio'] as number) * 100).toFixed(0)}% of budget (${severity})`
      case 'quality_drop':
        return `Node "${nodeId}" quality dropped below ${severity} threshold`
    }
  }

  private pushSuccessWindow(nodeId: string, success: boolean): void {
    const window = this.nodeSuccessWindow.get(nodeId) ?? []
    window.push(success)
    if (window.length > ERROR_WINDOW_SIZE) {
      window.splice(0, window.length - ERROR_WINDOW_SIZE)
    }
    this.nodeSuccessWindow.set(nodeId, window)
  }

  private getErrorRate(nodeId: string): number {
    const window = this.nodeSuccessWindow.get(nodeId)
    if (!window || window.length === 0) return 0
    const failures = window.filter((s) => !s).length
    return failures / window.length
  }

  private getWindowSize(nodeId: string): number {
    return this.nodeSuccessWindow.get(nodeId)?.length ?? 0
  }
}
