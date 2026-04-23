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

    return { stuck: false }
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
  }

  private hashInput(input: unknown): string {
    const str = typeof input === 'string' ? input : JSON.stringify(input)
    return createHash('sha256').update(str).digest('hex').slice(0, 16)
  }
}
