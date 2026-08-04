/**
 * CostAttributor — tracks per-agent, per-phase, and per-tool cost attribution.
 *
 * Subscribes to DzupEventBus for cost-related events and maintains
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

import type { DzupEventBus } from '@dzupagent/core/events'

// ------------------------------------------------------------------ Types

export interface CostEntry {
  agentId: string
  phase?: string | undefined
  toolName?: string | undefined
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
  /**
   * Retained entries — the most recent `maxEntries` (see
   * {@link CostAttributorConfig.maxEntries}). Totals and bucket aggregates
   * above are computed over *all* recorded entries, including evicted ones.
   */
  entries: CostEntry[]
  /** Total number of entries ever recorded, including evicted ones. */
  recordedEntryCount: number
  /** True when at least one entry has been evicted by the retention cap. */
  entriesTruncated: boolean
}

export interface CostAlertThreshold {
  maxCostCents?: number
  maxTokens?: number
  /** Ratio at which a warning is emitted (default: 0.8 = 80%) */
  warningRatio?: number
}

export interface CostAttributorConfig {
  thresholds?: CostAlertThreshold
  eventBus?: DzupEventBus
  /**
   * Maximum number of individual {@link CostEntry} records retained for
   * {@link CostReport.entries}. `attach()`-ed attributors are long-lived and
   * see one entry per LLM call / tool result / agent completion, so the entry
   * log is a ring buffer: once the cap is reached the oldest entry is dropped.
   * Running totals and the per-agent/phase/tool buckets are unaffected by
   * eviction — they are accumulated, not recomputed from `entries`.
   *
   * Default: 10 000. Set to `0` to disable retention entirely (totals only).
   */
  maxEntries?: number
}

/** Default retention cap for the per-entry cost log. */
export const DEFAULT_MAX_COST_ENTRIES = 10_000

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

  private _recordedEntryCount = 0
  private _entriesTruncated = false

  private readonly _thresholds: CostAlertThreshold
  private readonly _maxEntries: number
  private _eventBus: DzupEventBus | undefined
  private _unsubscribes: Array<() => void> = []
  private _currentPhase: string | undefined
  private _warningEmitted = false
  private _exceededEmitted = false

  constructor(config?: CostAttributorConfig) {
    this._thresholds = config?.thresholds ?? {}
    const configuredMax = config?.maxEntries
    this._maxEntries =
      configuredMax !== undefined && Number.isFinite(configuredMax) && configuredMax >= 0
        ? Math.floor(configuredMax)
        : DEFAULT_MAX_COST_ENTRIES
    if (config?.eventBus) {
      this.attach(config.eventBus)
    }
  }

  // ------------------------------------------------------ Lifecycle

  /**
   * Subscribe to DzupEventBus for cost-related events.
   */
  attach(eventBus: DzupEventBus): void {
    // Detach previous if any
    this.detach()
    this._eventBus = eventBus

    this._unsubscribes.push(
      // Adapter-layer runs report their spend on the terminal event
      // (`packages/agent-adapters/src/registry/event-bus-bridge.ts`). `usage`
      // is best-effort metadata: when the producer omits it we still record
      // the completion so entry/agent bookkeeping stays complete, but with an
      // explicit zero — there is genuinely no usage data to attribute, and
      // fabricating one would be worse than reporting none.
      eventBus.on('agent:completed', (e) => {
        this.record({
          agentId: e.agentId,
          phase: this._currentPhase,
          costCents: e.usage?.costCents ?? 0,
          tokens: (e.usage?.inputTokens ?? 0) + (e.usage?.outputTokens ?? 0),
          timestamp: new Date(),
        })
      }),

      // Native (in-process) runs report spend per LLM call instead
      // (`packages/agent/src/agent/run-engine-generate-tool-loop.ts` emits one
      // `llm:invoked` per invocation, with cost already resolved by
      // `calculateCostCents`). The two producers are disjoint — the native run
      // engine never populates `agent:completed.usage`, and the adapter bridge
      // never emits `llm:invoked` — so subscribing to both does not
      // double-count.
      //
      // NOTE: `cacheReadTokens` / `cacheWriteTokens` are deliberately excluded
      // from the token total here; cache-tier accounting is tracked separately
      // by DZUPAGENT-AGENT-M-27 and folding it in now would silently change
      // the meaning of `maxTokens` thresholds.
      eventBus.on('llm:invoked', (e) => {
        this.record({
          agentId: e.agentId,
          phase: this._currentPhase,
          costCents: e.costCents,
          tokens: e.inputTokens + e.outputTokens,
          timestamp: new Date(),
        })
      }),

      // `tool:result` carries no usage or cost fields (see
      // `packages/core/src/events/event-types-*.ts`), so tool-level cost is
      // structurally zero: the entry exists to populate `byTool` call counts
      // and phase attribution only. Attributing LLM spend to the tool that
      // triggered it requires correlating `tool:result` with the surrounding
      // `llm:invoked` — out of scope for C-07, tracked under MJ-03.
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
    this._recordedEntryCount += 1
    if (this._maxEntries > 0) {
      this._entries.push(entry)
      if (this._entries.length > this._maxEntries) {
        this._entries.splice(0, this._entries.length - this._maxEntries)
        this._entriesTruncated = true
      }
    } else if (this._recordedEntryCount > 0) {
      this._entriesTruncated = true
    }
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
      recordedEntryCount: this._recordedEntryCount,
      entriesTruncated: this._entriesTruncated,
    }
  }

  /**
   * Reset all tracked costs.
   */
  reset(): void {
    this._entries.length = 0
    this._recordedEntryCount = 0
    this._entriesTruncated = false
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
      // Monotonic count — must not shrink when the entry log is evicted.
      iterations: this._recordedEntryCount,
      iterationsLimit: maxVal,
      percent,
    }
  }
}
