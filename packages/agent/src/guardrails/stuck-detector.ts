/**
 * Stuck detector — identifies when an agent is making no progress.
 *
 * Detects:
 * - Repeated identical tool calls (same name + same input hash)
 * - High error rate within a time window
 * - No-progress iterations (no new tool calls or outputs)
 */
import { createHash } from 'node:crypto'
import type { StuckDetectorConfig } from '@dzupagent/agent-types'

export type { StuckDetectorConfig }

export interface StuckStatus {
  stuck: boolean
  reason?: string
}

/** Fully-resolved config with all defaults applied. */
type ResolvedStuckDetectorConfig = Required<StuckDetectorConfig>

const DEFAULT_CONFIG: ResolvedStuckDetectorConfig = {
  maxRepeatCalls: 3,
  maxErrorsInWindow: 5,
  errorWindowMs: 60_000,
  maxIdleIterations: 3,
}

export class StuckDetector {
  private recentCalls: Array<{ name: string; hash: string; timestamp: number }> = []
  private recentErrors: Array<{ message: string; timestamp: number }> = []
  private idleCount = 0
  private _lastToolCallCount = 0
  private readonly config: ResolvedStuckDetectorConfig

  // Progress-hash detection state (non-overlapping block hashing)
  private readonly hashWindow = 5
  private readonly hashRepeatThreshold = 3
  private currentBlock: string[] = []
  private lastCompletedBlock: string[] = []
  private hashHistory: string[] = []

  constructor(config?: StuckDetectorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Number of tool calls in the most recent iteration */
  get lastToolCalls(): number {
    return this._lastToolCallCount
  }

  /** Record a tool call. Returns stuck status. */
  recordToolCall(name: string, input: unknown): StuckStatus {
    const hash = this.hashInput(input)
    this.recentCalls.push({ name, hash, timestamp: Date.now() })
    this.idleCount = 0 // tool call = progress

    // Check for repeated identical calls
    const tail = this.recentCalls.slice(-this.config.maxRepeatCalls)
    if (tail.length >= this.config.maxRepeatCalls) {
      const first = tail[0]!
      const allSame = tail.every(c => c.name === first.name && c.hash === first.hash)
      if (allSame) {
        return {
          stuck: true,
          reason: `Tool "${name}" called ${this.config.maxRepeatCalls} times with identical input`,
        }
      }
    }

    // Progress-hash check: detect repeated identical non-overlapping blocks
    this.recordToolNameForHash(name)
    if (this.isStuckByHash()) {
      return {
        stuck: true,
        reason: `Identical tool sequence repeated ${this.hashRepeatThreshold} times: [${this.lastCompletedBlock.join(', ')}]`,
      }
    }

    return { stuck: false }
  }

  /**
   * Accumulate tool names into non-overlapping blocks of `hashWindow`.
   * Each time a block is complete its hash is appended to `hashHistory`.
   * Called internally on every tool call.
   */
  private recordToolNameForHash(toolName: string): void {
    this.currentBlock.push(toolName)
    if (this.currentBlock.length === this.hashWindow) {
      const blockHash = this.currentBlock.join('|')
      this.hashHistory.push(blockHash)
      if (this.hashHistory.length > this.hashRepeatThreshold) {
        this.hashHistory.shift()
      }
      this.lastCompletedBlock = [...this.currentBlock]
      this.currentBlock = []
    }
  }

  /**
   * Returns true when the last `hashRepeatThreshold` non-overlapping blocks
   * all produced the same hash — meaning the agent called the exact same
   * sequence of `hashWindow` tool names that many consecutive times.
   */
  private isStuckByHash(): boolean {
    if (this.hashHistory.length < this.hashRepeatThreshold) return false
    const first = this.hashHistory[0]!
    return this.hashHistory.every(h => h === first)
  }

  /** Record an error. Returns stuck status. */
  recordError(error: Error): StuckStatus {
    this.recentErrors.push({ message: error.message, timestamp: Date.now() })

    // Check error rate in window
    const windowStart = Date.now() - this.config.errorWindowMs
    const recent = this.recentErrors.filter(e => e.timestamp >= windowStart)
    if (recent.length >= this.config.maxErrorsInWindow) {
      return {
        stuck: true,
        reason: `${recent.length} errors in ${Math.round(this.config.errorWindowMs / 1000)}s window`,
      }
    }

    return { stuck: false }
  }

  /** Record an iteration tick. Detects idle (no tool calls) iterations. */
  recordIteration(toolCallsThisIteration: number): StuckStatus {
    if (toolCallsThisIteration === 0) {
      this.idleCount++
    } else {
      this.idleCount = 0
    }
    this._lastToolCallCount = toolCallsThisIteration

    if (this.idleCount >= this.config.maxIdleIterations) {
      return {
        stuck: true,
        reason: `${this.idleCount} consecutive iterations with no tool calls`,
      }
    }

    return { stuck: false }
  }

  /** Reset all tracking state */
  reset(): void {
    this.recentCalls = []
    this.recentErrors = []
    this.idleCount = 0
    this._lastToolCallCount = 0
    this.currentBlock = []
    this.lastCompletedBlock = []
    this.hashHistory = []
  }

  private hashInput(input: unknown): string {
    const str = typeof input === 'string' ? input : JSON.stringify(input)
    return createHash('sha256').update(str).digest('hex').slice(0, 16)
  }
}
