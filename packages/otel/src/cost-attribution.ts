/**
 * CostAttributor — tracks per-agent, per-phase, and per-tool cost attribution.
 *
 * Subscribes to DzipEventBus for cost-related events and maintains
 * running totals. Emits budget:warning and budget:exceeded events
 * when configured thresholds are crossed.
 *
 * @example
 * ```ts
 * const bus = createEventBus()
 * const cost = new CostAttributor({ thresholds: { maxCostCents: 500 } })
 * cost.attach(bus)
 *
 * // ... agent runs ...
 * const report = cost.getCostReport()
 * console.log(report.totalCostCents, report.byAgent)
 * ```
 */

import type { DzipEventBus } from '@dzipagent/core'

// ------------------------------------------------------------------ Types

export interface CostEntry {
  agentId: string
  phase?: string
  toolName?: string
  costCents: number
  tokens: number
  timestamp: Date
}

export interface CostReport {
  totalCostCents: number
  totalTokens: number
  byAgent: Record<string, { costCents: number; tokens: number }>
  byPhase: Record<string, { costCents: number; tokens: number }>
  byTool: Record<string, { costCents: number; tokens: number }>
  entries: CostEntry[]
}

export interface CostAlertThreshold {
  maxCostCents?: number
  maxTokens?: number
  /** Ratio at which a warning is emitted (default: 0.8 = 80%) */
  warningRatio?: number
}

export interface CostAttributorConfig {
  thresholds?: CostAlertThreshold
  eventBus?: DzipEventBus
}

// ----------------------------------------------------------- Accumulator

interface Bucket {
  costCents: number
  tokens: number
}

function addToBucket(
  map: Map<string, Bucket>,
  key: string,
  costCents: number,
  tokens: number,
): void {
  const existing = map.get(key)
  if (existing) {
    existing.costCents += costCents
    existing.tokens += tokens
  } else {
    map.set(key, { costCents, tokens })
  }
}

function bucketMapToRecord(map: Map<string, Bucket>): Record<string, { costCents: number; tokens: number }> {
  const out: Record<string, { costCents: number; tokens: number }> = {}
  for (const [k, v] of map) {
    out[k] = { costCents: v.costCents, tokens: v.tokens }
  }
  return out
}

// -------------------------------------------------------------- Class

export class CostAttributor {
  private readonly _entries: CostEntry[] = []
  private readonly _byAgent = new Map<string, Bucket>()
  private readonly _byPhase = new Map<string, Bucket>()
  private readonly _byTool = new Map<string, Bucket>()
  private _totalCostCents = 0
  private _totalTokens = 0

  private readonly _thresholds: CostAlertThreshold
  private _eventBus: DzipEventBus | undefined
  private _unsubscribes: Array<() => void> = []
  private _currentPhase: string | undefined
  private _warningEmitted = false
  private _exceededEmitted = false

  constructor(config?: CostAttributorConfig) {
    this._thresholds = config?.thresholds ?? {}
    if (config?.eventBus) {
      this.attach(config.eventBus)
    }
  }

  // ------------------------------------------------------ Lifecycle

  /**
   * Subscribe to DzipEventBus for cost-related events.
   */
  attach(eventBus: DzipEventBus): void {
    // Detach previous if any
    this.detach()
    this._eventBus = eventBus

    this._unsubscribes.push(
      eventBus.on('agent:completed', (e) => {
        this.record({
          agentId: e.agentId,
          phase: this._currentPhase,
          costCents: 0,
          tokens: 0,
          timestamp: new Date(),
        })
      }),

      eventBus.on('tool:result', (e) => {
        this.record({
          agentId: '__unknown__',
          toolName: e.toolName,
          phase: this._currentPhase,
          costCents: 0,
          tokens: 0,
          timestamp: new Date(),
        })
      }),

      eventBus.on('pipeline:phase_changed', (e) => {
        this._currentPhase = e.phase
      }),

      eventBus.on('budget:warning', (_e) => {
        // Relay — already handled by threshold checks in record()
      }),

      eventBus.on('budget:exceeded', (_e) => {
        // Relay — already handled by threshold checks in record()
      }),
    )
  }

  /**
   * Detach from the event bus.
   */
  detach(): void {
    for (const unsub of this._unsubscribes) {
      unsub()
    }
    this._unsubscribes = []
    this._eventBus = undefined
  }

  // --------------------------------------------------- Manual recording

  /**
   * Record a cost entry manually.
   */
  record(entry: CostEntry): void {
    this._entries.push(entry)
    this._totalCostCents += entry.costCents
    this._totalTokens += entry.tokens

    addToBucket(this._byAgent, entry.agentId, entry.costCents, entry.tokens)

    if (entry.phase) {
      addToBucket(this._byPhase, entry.phase, entry.costCents, entry.tokens)
    }
    if (entry.toolName) {
      addToBucket(this._byTool, entry.toolName, entry.costCents, entry.tokens)
    }

    this._checkThresholds()
  }

  // --------------------------------------------------- Reporting

  /**
   * Get the aggregated cost report.
   */
  getCostReport(): CostReport {
    return {
      totalCostCents: this._totalCostCents,
      totalTokens: this._totalTokens,
      byAgent: bucketMapToRecord(this._byAgent),
      byPhase: bucketMapToRecord(this._byPhase),
      byTool: bucketMapToRecord(this._byTool),
      entries: [...this._entries],
    }
  }

  /**
   * Reset all tracked costs.
   */
  reset(): void {
    this._entries.length = 0
    this._byAgent.clear()
    this._byPhase.clear()
    this._byTool.clear()
    this._totalCostCents = 0
    this._totalTokens = 0
    this._warningEmitted = false
    this._exceededEmitted = false
    this._currentPhase = undefined
  }

  // --------------------------------------------------- Threshold checks

  private _checkThresholds(): void {
    if (!this._eventBus) return

    const warningRatio = this._thresholds.warningRatio ?? 0.8
    const { maxCostCents, maxTokens } = this._thresholds

    // Check cost threshold
    if (maxCostCents !== undefined && maxCostCents > 0) {
      const ratio = this._totalCostCents / maxCostCents
      if (ratio >= 1 && !this._exceededEmitted) {
        this._exceededEmitted = true
        this._eventBus.emit({
          type: 'budget:exceeded',
          reason: 'cost',
          usage: this._buildUsage(),
        })
      } else if (ratio >= warningRatio && !this._warningEmitted) {
        this._warningEmitted = true
        this._eventBus.emit({
          type: 'budget:warning',
          level: 'critical',
          usage: this._buildUsage(),
        })
      }
    }

    // Check token threshold
    if (maxTokens !== undefined && maxTokens > 0) {
      const ratio = this._totalTokens / maxTokens
      if (ratio >= 1 && !this._exceededEmitted) {
        this._exceededEmitted = true
        this._eventBus.emit({
          type: 'budget:exceeded',
          reason: 'tokens',
          usage: this._buildUsage(),
        })
      } else if (ratio >= warningRatio && !this._warningEmitted) {
        this._warningEmitted = true
        this._eventBus.emit({
          type: 'budget:warning',
          level: 'warn',
          usage: this._buildUsage(),
        })
      }
    }
  }

  private _buildUsage() {
    const maxCostCents = this._thresholds.maxCostCents ?? 0
    const maxTokens = this._thresholds.maxTokens ?? 0
    const maxVal = Math.max(maxCostCents, maxTokens, 1)
    const percent = Math.round(
      (Math.max(
        maxCostCents > 0 ? this._totalCostCents / maxCostCents : 0,
        maxTokens > 0 ? this._totalTokens / maxTokens : 0,
      )) * 100,
    )
    return {
      tokensUsed: this._totalTokens,
      tokensLimit: maxTokens,
      costCents: this._totalCostCents,
      costLimitCents: maxCostCents,
      iterations: this._entries.length,
      iterationsLimit: maxVal,
      percent,
    }
  }
}
