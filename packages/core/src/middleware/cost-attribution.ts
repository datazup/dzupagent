/**
 * Cost attribution middleware — tracks LLM costs per agent, tool, run, and model.
 *
 * Collects CostAttribution entries and aggregates them into a CostReport
 * bucketed by agent, tool, run, and model.
 */

/** A single cost attribution entry tied to an LLM invocation. */
export interface CostAttribution {
  agentId: string
  toolName?: string
  runId?: string
  costCents: number
  tokens: { input: number; output: number; total: number }
  model: string
  timestamp: Date
}

/** Aggregated bucket used in reports. */
export interface CostBucket {
  costCents: number
  tokens: number
  calls: number
}

/** Aggregated cost report across all recorded entries. */
export interface CostReport {
  totalCostCents: number
  totalTokens: number
  byAgent: Record<string, CostBucket>
  byTool: Record<string, CostBucket>
  byRun: Record<string, CostBucket>
  byModel: Record<string, CostBucket>
  entries: ReadonlyArray<CostAttribution>
}

/** Configuration for the CostAttributionCollector. */
export interface CostAttributionConfig {
  /** Default agent ID for tagging new entries. */
  agentId?: string
  /** Default run ID for tagging new entries. */
  runId?: string
}

/** Mutable context that auto-tags subsequent records. */
interface AttributionContext {
  agentId?: string
  runId?: string
  toolName?: string
}

/**
 * Collects cost attribution entries and produces aggregated reports.
 *
 * Usage:
 * ```ts
 * const collector = new CostAttributionCollector({ agentId: 'planner' });
 * collector.record({ agentId: 'planner', model: 'claude-sonnet-4-6', ... });
 * const report = collector.getReport();
 * ```
 */
export class CostAttributionCollector {
  private entries: CostAttribution[] = []
  private context: AttributionContext

  constructor(config?: CostAttributionConfig) {
    this.context = {
      ...(config?.agentId !== undefined && { agentId: config.agentId }),
      ...(config?.runId !== undefined && { runId: config.runId }),
    }
  }

  /**
   * Record a cost attribution entry.
   * Fields from the current context are used as defaults — explicit values
   * in the entry take precedence.
   */
  record(entry: CostAttribution): void {
    const runId = entry.runId ?? this.context.runId
    const toolName = entry.toolName ?? this.context.toolName
    const merged: CostAttribution = {
      ...entry,
      agentId: entry.agentId || this.context.agentId || 'unknown',
      ...(runId !== undefined && { runId }),
      ...(toolName !== undefined && { toolName }),
    }
    this.entries.push(merged)
  }

  /** Build an aggregated cost report from all recorded entries. */
  getReport(): CostReport {
    const byAgent: Record<string, CostBucket> = {}
    const byTool: Record<string, CostBucket> = {}
    const byRun: Record<string, CostBucket> = {}
    const byModel: Record<string, CostBucket> = {}

    let totalCostCents = 0
    let totalTokens = 0

    for (const entry of this.entries) {
      totalCostCents += entry.costCents
      totalTokens += entry.tokens.total

      addToBucket(byAgent, entry.agentId, entry)
      addToBucket(byModel, entry.model, entry)

      if (entry.toolName) {
        addToBucket(byTool, entry.toolName, entry)
      }
      if (entry.runId) {
        addToBucket(byRun, entry.runId, entry)
      }
    }

    return {
      totalCostCents,
      totalTokens,
      byAgent,
      byTool,
      byRun,
      byModel,
      entries: this.entries,
    }
  }

  /** Get total cost in cents for a specific agent. Returns 0 if not found. */
  getAgentCost(agentId: string): number {
    let cost = 0
    for (const entry of this.entries) {
      if (entry.agentId === agentId) {
        cost += entry.costCents
      }
    }
    return cost
  }

  /** Get total cost in cents for a specific run. Returns 0 if not found. */
  getRunCost(runId: string): number {
    let cost = 0
    for (const entry of this.entries) {
      if (entry.runId === runId) {
        cost += entry.costCents
      }
    }
    return cost
  }

  /** Reset all collected data and context overrides. */
  reset(): void {
    this.entries = []
  }

  /**
   * Set context for subsequent recordings.
   * Only provided fields are updated; omitted fields remain unchanged.
   */
  setContext(ctx: { agentId?: string; runId?: string; toolName?: string }): void {
    if (ctx.agentId !== undefined) this.context.agentId = ctx.agentId
    if (ctx.runId !== undefined) this.context.runId = ctx.runId
    if (ctx.toolName !== undefined) this.context.toolName = ctx.toolName
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function addToBucket(
  buckets: Record<string, CostBucket>,
  key: string,
  entry: CostAttribution,
): void {
  const existing = buckets[key]
  if (existing) {
    existing.costCents += entry.costCents
    existing.tokens += entry.tokens.total
    existing.calls += 1
  } else {
    buckets[key] = {
      costCents: entry.costCents,
      tokens: entry.tokens.total,
      calls: 1,
    }
  }
}
