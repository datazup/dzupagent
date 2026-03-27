/**
 * Pipeline analytics — aggregates run metrics, computes per-node statistics,
 * and identifies bottlenecks across pipeline executions.
 *
 * @module pipeline/pipeline-analytics
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregated metrics for a single pipeline node across all runs. */
export interface NodeMetrics {
  nodeId: string
  nodeType: string
  executionCount: number
  successCount: number
  failureCount: number
  avgDurationMs: number
  minDurationMs: number
  maxDurationMs: number
  totalCostCents?: number
  /** Success rate from 0 to 1. */
  successRate: number
}

/** Bottleneck entry identifying a problematic node. */
export interface BottleneckEntry {
  nodeId: string
  reason: 'slowest' | 'most-expensive' | 'highest-failure-rate'
  value: number
}

/** Full analytics report for a pipeline. */
export interface PipelineAnalyticsReport {
  pipelineId: string
  totalRuns: number
  avgDurationMs: number
  successRate: number
  nodeMetrics: NodeMetrics[]
  bottlenecks: BottleneckEntry[]
  costByNodeType: Record<string, number>
}

/** A single node result as ingested by `addRun`. */
export interface AnalyticsNodeResult {
  nodeId: string
  output: unknown
  durationMs: number
  error?: string
}

/** A pipeline run result as ingested by `addRun`. */
export interface AnalyticsRunInput {
  pipelineId: string
  runId: string
  state: string
  nodeResults: Map<string, AnalyticsNodeResult>
  totalDurationMs: number
}

// ---------------------------------------------------------------------------
// Internal accumulator
// ---------------------------------------------------------------------------

interface NodeAccumulator {
  nodeId: string
  nodeType: string
  durations: number[]
  successCount: number
  failureCount: number
  totalCostCents: number
}

interface PipelineAccumulator {
  runDurations: number[]
  successCount: number
  totalRuns: number
  nodes: Map<string, NodeAccumulator>
}

// ---------------------------------------------------------------------------
// PipelineAnalytics
// ---------------------------------------------------------------------------

/**
 * Collects pipeline run data and produces analytics reports.
 *
 * Thread-safe for single-threaded Node.js usage (no concurrent mutation).
 */
export class PipelineAnalytics {
  private readonly pipelines = new Map<string, PipelineAccumulator>()

  /** Add a completed run result for analysis. */
  addRun(result: AnalyticsRunInput): void {
    let acc = this.pipelines.get(result.pipelineId)
    if (!acc) {
      acc = { runDurations: [], successCount: 0, totalRuns: 0, nodes: new Map() }
      this.pipelines.set(result.pipelineId, acc)
    }

    acc.totalRuns++
    acc.runDurations.push(result.totalDurationMs)

    const isSuccess = result.state === 'completed'
    if (isSuccess) {
      acc.successCount++
    }

    for (const [_key, nr] of result.nodeResults) {
      let nodeAcc = acc.nodes.get(nr.nodeId)
      if (!nodeAcc) {
        nodeAcc = {
          nodeId: nr.nodeId,
          nodeType: inferNodeType(nr.nodeId),
          durations: [],
          successCount: 0,
          failureCount: 0,
          totalCostCents: 0,
        }
        acc.nodes.set(nr.nodeId, nodeAcc)
      }

      nodeAcc.durations.push(nr.durationMs)
      if (nr.error) {
        nodeAcc.failureCount++
      } else {
        nodeAcc.successCount++
      }

      // Extract cost from output if present
      const cost = extractCost(nr.output)
      if (cost > 0) {
        nodeAcc.totalCostCents += cost
      }
    }
  }

  /** Generate an analytics report for a pipeline. */
  getReport(pipelineId: string): PipelineAnalyticsReport {
    const acc = this.pipelines.get(pipelineId)
    if (!acc || acc.totalRuns === 0) {
      return {
        pipelineId,
        totalRuns: 0,
        avgDurationMs: 0,
        successRate: 0,
        nodeMetrics: [],
        bottlenecks: [],
        costByNodeType: {},
      }
    }

    const avgDurationMs = mean(acc.runDurations)
    const successRate = acc.totalRuns > 0 ? acc.successCount / acc.totalRuns : 0

    const nodeMetrics: NodeMetrics[] = []
    const costByNodeType: Record<string, number> = {}

    for (const nodeAcc of acc.nodes.values()) {
      const total = nodeAcc.successCount + nodeAcc.failureCount
      const avgDur = mean(nodeAcc.durations)
      const minDur = nodeAcc.durations.length > 0 ? Math.min(...nodeAcc.durations) : 0
      const maxDur = nodeAcc.durations.length > 0 ? Math.max(...nodeAcc.durations) : 0
      const sr = total > 0 ? nodeAcc.successCount / total : 0

      const nm: NodeMetrics = {
        nodeId: nodeAcc.nodeId,
        nodeType: nodeAcc.nodeType,
        executionCount: total,
        successCount: nodeAcc.successCount,
        failureCount: nodeAcc.failureCount,
        avgDurationMs: avgDur,
        minDurationMs: minDur,
        maxDurationMs: maxDur,
        successRate: sr,
      }

      if (nodeAcc.totalCostCents > 0) {
        nm.totalCostCents = nodeAcc.totalCostCents
      }

      nodeMetrics.push(nm)

      // Aggregate cost by node type
      const existing = costByNodeType[nodeAcc.nodeType] ?? 0
      costByNodeType[nodeAcc.nodeType] = existing + nodeAcc.totalCostCents
    }

    const bottlenecks = this.computeBottlenecks(nodeMetrics)

    return {
      pipelineId,
      totalRuns: acc.totalRuns,
      avgDurationMs,
      successRate,
      nodeMetrics,
      bottlenecks,
      costByNodeType,
    }
  }

  /** Get the top bottleneck nodes for a pipeline. */
  getBottlenecks(pipelineId: string, limit = 5): BottleneckEntry[] {
    const report = this.getReport(pipelineId)
    return report.bottlenecks.slice(0, limit)
  }

  /** Reset all analytics data. */
  reset(): void {
    this.pipelines.clear()
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private computeBottlenecks(nodeMetrics: NodeMetrics[]): BottleneckEntry[] {
    const bottlenecks: BottleneckEntry[] = []

    if (nodeMetrics.length === 0) {
      return bottlenecks
    }

    // Slowest node by avgDurationMs
    const sorted = [...nodeMetrics].sort((a, b) => b.avgDurationMs - a.avgDurationMs)
    const slowest = sorted[0]
    if (slowest && slowest.avgDurationMs > 0) {
      bottlenecks.push({
        nodeId: slowest.nodeId,
        reason: 'slowest',
        value: slowest.avgDurationMs,
      })
    }

    // Most expensive node by totalCostCents
    const withCost = nodeMetrics.filter((n) => n.totalCostCents !== undefined && n.totalCostCents > 0)
    if (withCost.length > 0) {
      const expensive = withCost.sort((a, b) => (b.totalCostCents ?? 0) - (a.totalCostCents ?? 0))[0]
      if (expensive) {
        bottlenecks.push({
          nodeId: expensive.nodeId,
          reason: 'most-expensive',
          value: expensive.totalCostCents ?? 0,
        })
      }
    }

    // Highest failure rate (min 3 executions to avoid noise)
    const withEnoughRuns = nodeMetrics.filter((n) => n.executionCount >= 3)
    if (withEnoughRuns.length > 0) {
      const highestFailure = withEnoughRuns.sort((a, b) => a.successRate - b.successRate)[0]
      if (highestFailure && highestFailure.successRate < 1) {
        bottlenecks.push({
          nodeId: highestFailure.nodeId,
          reason: 'highest-failure-rate',
          value: highestFailure.successRate,
        })
      }
    }

    return bottlenecks
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** Infer a node type from the nodeId (use prefix before colon or hyphen). */
function inferNodeType(nodeId: string): string {
  // e.g. "llm:generate" -> "llm", "validate-schema" -> "validate"
  const colonIdx = nodeId.indexOf(':')
  if (colonIdx > 0) return nodeId.substring(0, colonIdx)
  const hyphenIdx = nodeId.indexOf('-')
  if (hyphenIdx > 0) return nodeId.substring(0, hyphenIdx)
  return nodeId
}

/** Safely extract a cost value from node output, if present. */
function extractCost(output: unknown): number {
  if (output !== null && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if (typeof obj['costCents'] === 'number') return obj['costCents']
    if (typeof obj['cost_cents'] === 'number') return obj['cost_cents']
    if (typeof obj['cost'] === 'number') return obj['cost']
  }
  return 0
}
