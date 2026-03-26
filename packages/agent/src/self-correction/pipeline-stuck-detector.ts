/**
 * Pipeline-level stuck detector — identifies when a multi-node pipeline
 * is making no progress.
 *
 * Detects:
 * - Per-node failure counts exceeding a threshold
 * - Identical outputs from the same node (output hash loops)
 * - Total pipeline-level retries exceeding a global limit
 *
 * Distinct from the tool-loop StuckDetector which operates within a single
 * agent call. This detector operates across pipeline nodes.
 */
import { createHash } from 'node:crypto'

export type PipelineSuggestedAction =
  | 'retry_with_hint'
  | 'skip_node'
  | 'switch_strategy'
  | 'abort'

export interface PipelineStuckStatus {
  stuck: boolean
  reason?: string
  nodeId?: string
  suggestedAction?: PipelineSuggestedAction
}

export interface PipelineStuckConfig {
  /** Max failures per node before flagging stuck (default: 3) */
  maxNodeFailures: number
  /** Max identical outputs from same node (default: 3) */
  maxIdenticalOutputs: number
  /** Max total pipeline-level retries across all nodes (default: 10) */
  maxTotalRetries: number
  /** Time window for failure rate calculation in ms (default: 300_000 = 5min) */
  failureWindowMs: number
}

export interface PipelineStuckSummary {
  nodeFailures: Map<string, number>
  totalRetries: number
  identicalOutputNodes: string[]
}

const DEFAULT_CONFIG: PipelineStuckConfig = {
  maxNodeFailures: 3,
  maxIdenticalOutputs: 3,
  maxTotalRetries: 10,
  failureWindowMs: 300_000,
}

export class PipelineStuckDetector {
  private nodeFailures = new Map<string, Array<{ error: string; timestamp: number }>>()
  private nodeOutputHashes = new Map<string, string[]>()
  private totalRetries = 0
  private readonly config: PipelineStuckConfig

  constructor(config?: Partial<PipelineStuckConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Record a node execution failure. Returns stuck status. */
  recordNodeFailure(nodeId: string, error: string): PipelineStuckStatus {
    const entries = this.nodeFailures.get(nodeId) ?? []
    entries.push({ error, timestamp: Date.now() })
    this.nodeFailures.set(nodeId, entries)

    // Count failures within the time window
    const windowStart = Date.now() - this.config.failureWindowMs
    const recentFailures = entries.filter(e => e.timestamp >= windowStart)
    const count = recentFailures.length

    if (count >= this.config.maxNodeFailures) {
      return {
        stuck: true,
        reason: `Node "${nodeId}" failed ${count} times within ${Math.round(this.config.failureWindowMs / 1000)}s window`,
        nodeId,
        suggestedAction: this.escalateAction(count),
      }
    }

    return { stuck: false }
  }

  /** Record a node output (success). Checks for identical output loops. */
  recordNodeOutput(nodeId: string, output: string): PipelineStuckStatus {
    const hash = this.hashOutput(output)
    const hashes = this.nodeOutputHashes.get(nodeId) ?? []
    hashes.push(hash)

    // Keep only the last 5 hashes per node
    if (hashes.length > 5) {
      hashes.splice(0, hashes.length - 5)
    }
    this.nodeOutputHashes.set(nodeId, hashes)

    // Check if the last N outputs are all identical
    const tail = hashes.slice(-this.config.maxIdenticalOutputs)
    if (tail.length >= this.config.maxIdenticalOutputs) {
      const first = tail[0]!
      const allSame = tail.every(h => h === first)
      if (allSame) {
        return {
          stuck: true,
          reason: `Node "${nodeId}" produced ${this.config.maxIdenticalOutputs} identical outputs`,
          nodeId,
          suggestedAction: 'switch_strategy',
        }
      }
    }

    return { stuck: false }
  }

  /** Record a pipeline-level retry. */
  recordRetry(): PipelineStuckStatus {
    this.totalRetries++

    if (this.totalRetries >= this.config.maxTotalRetries) {
      return {
        stuck: true,
        reason: `Pipeline exceeded ${this.config.maxTotalRetries} total retries`,
        suggestedAction: 'abort',
      }
    }

    return { stuck: false }
  }

  /** Get failure count for a specific node */
  getNodeFailureCount(nodeId: string): number {
    return this.nodeFailures.get(nodeId)?.length ?? 0
  }

  /** Get total retry count */
  getTotalRetries(): number {
    return this.totalRetries
  }

  /** Get a summary of all stuck signals */
  getSummary(): PipelineStuckSummary {
    const nodeFailureCounts = new Map<string, number>()
    for (const [nodeId, entries] of this.nodeFailures) {
      nodeFailureCounts.set(nodeId, entries.length)
    }

    const identicalOutputNodes: string[] = []
    for (const [nodeId, hashes] of this.nodeOutputHashes) {
      const tail = hashes.slice(-this.config.maxIdenticalOutputs)
      if (tail.length >= this.config.maxIdenticalOutputs) {
        const first = tail[0]!
        if (tail.every(h => h === first)) {
          identicalOutputNodes.push(nodeId)
        }
      }
    }

    return {
      nodeFailures: nodeFailureCounts,
      totalRetries: this.totalRetries,
      identicalOutputNodes,
    }
  }

  /** Reset all tracking state */
  reset(): void {
    this.nodeFailures.clear()
    this.nodeOutputHashes.clear()
    this.totalRetries = 0
  }

  /** Escalate suggested action based on failure count */
  private escalateAction(failureCount: number): PipelineSuggestedAction {
    if (failureCount >= 3) return 'abort'
    if (failureCount === 2) return 'switch_strategy'
    return 'retry_with_hint'
  }

  private hashOutput(output: string): string {
    return createHash('sha256').update(output).digest('hex').slice(0, 16)
  }
}
