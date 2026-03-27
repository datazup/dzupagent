/**
 * TraceCapture — subscribes to DzipEventBus to capture all events
 * during an agent run, with configurable snapshot intervals and filters.
 *
 * @module replay/trace-capture
 */

import type { DzipEventBus, DzipEvent } from '@dzipagent/core'
import type {
  ReplayEvent,
  TraceCaptureConfig,
  CapturedTrace,
} from './replay-types.js'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: TraceCaptureConfig = {
  snapshotInterval: 10,
  maxEvents: 10_000,
}

// ---------------------------------------------------------------------------
// TraceCapture
// ---------------------------------------------------------------------------

/**
 * Captures events from a DzipEventBus into a replayable trace.
 *
 * Usage:
 * ```ts
 * const capture = new TraceCapture(eventBus, { snapshotInterval: 5 })
 * capture.start('run-123', 'agent-1')
 * // ... agent executes, events flow through the bus ...
 * const trace = capture.stop()
 * ```
 */
export class TraceCapture {
  private readonly bus: DzipEventBus
  private readonly config: TraceCaptureConfig
  private events: ReplayEvent[] = []
  private runId: string | undefined
  private agentId: string | undefined
  private startedAt: number | undefined
  private unsubscribe: (() => void) | undefined
  private stateProvider: (() => Record<string, unknown>) | undefined
  private capturing = false

  constructor(bus: DzipEventBus, config?: Partial<TraceCaptureConfig>) {
    this.bus = bus
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Register an optional state provider function that is called at snapshot
   * intervals to capture the current execution state.
   */
  setStateProvider(provider: () => Record<string, unknown>): void {
    this.stateProvider = provider
  }

  /**
   * Start capturing events for a run.
   *
   * @param runId - The run being traced.
   * @param agentId - The agent producing the trace.
   */
  start(runId: string, agentId?: string): void {
    if (this.capturing) {
      throw new Error('TraceCapture is already capturing. Call stop() first.')
    }

    this.runId = runId
    this.agentId = agentId
    this.events = []
    this.startedAt = Date.now()
    this.capturing = true

    this.unsubscribe = this.bus.onAny((event: DzipEvent) => {
      this.handleEvent(event)
    })
  }

  /**
   * Stop capturing and return the completed trace.
   */
  stop(): CapturedTrace {
    if (!this.capturing || !this.runId) {
      throw new Error('TraceCapture is not capturing. Call start() first.')
    }

    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.capturing = false

    const trace: CapturedTrace = {
      schemaVersion: '1.0.0',
      runId: this.runId,
      agentId: this.agentId,
      events: [...this.events],
      startedAt: this.startedAt ?? Date.now(),
      completedAt: Date.now(),
      config: { ...this.config },
    }

    return trace
  }

  /**
   * Whether the capture is currently active.
   */
  isCapturing(): boolean {
    return this.capturing
  }

  /**
   * Get events captured so far (without stopping).
   */
  peek(): readonly ReplayEvent[] {
    return this.events
  }

  /**
   * Get the current event count.
   */
  get eventCount(): number {
    return this.events.length
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private handleEvent(event: DzipEvent): void {
    if (!this.shouldCapture(event.type)) return

    const index = this.events.length

    // Capture state snapshot at configured intervals
    let stateSnapshot: Record<string, unknown> | undefined
    if (
      this.config.snapshotInterval > 0 &&
      index % this.config.snapshotInterval === 0 &&
      this.stateProvider
    ) {
      try {
        stateSnapshot = structuredClone(this.stateProvider())
      } catch {
        // If state is not cloneable, skip snapshot
        stateSnapshot = undefined
      }
    }

    // Destructure type out of the event, rest is data
    const { type, ...data } = event

    // Extract nodeId from common event shapes
    const nodeId = extractNodeId(data)

    const replayEvent: ReplayEvent = {
      index,
      timestamp: Date.now(),
      type,
      nodeId,
      data: data as Record<string, unknown>,
      stateSnapshot,
    }

    this.events.push(replayEvent)

    // Enforce max events by dropping oldest
    if (this.config.maxEvents && this.config.maxEvents > 0 && this.events.length > this.config.maxEvents) {
      const excess = this.events.length - this.config.maxEvents
      this.events.splice(0, excess)
      // Re-index
      for (let i = 0; i < this.events.length; i++) {
        this.events[i]!.index = i
      }
    }
  }

  private shouldCapture(eventType: string): boolean {
    const { includeTypes, excludeTypes } = this.config

    // If include list is set, event must match
    if (includeTypes && includeTypes.length > 0) {
      if (!includeTypes.some(pattern => matchPattern(eventType, pattern))) {
        return false
      }
    }

    // If exclude list is set, event must not match
    if (excludeTypes && excludeTypes.length > 0) {
      if (excludeTypes.some(pattern => matchPattern(eventType, pattern))) {
        return false
      }
    }

    return true
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple pattern matching: supports exact match and wildcard prefix
 * (e.g., "pipeline:*" matches "pipeline:node_started").
 */
function matchPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1))
  }
  return value === pattern
}

/**
 * Extract a nodeId from common event payload shapes.
 */
function extractNodeId(data: Record<string, unknown>): string | undefined {
  if (typeof data['nodeId'] === 'string') return data['nodeId']
  if (typeof data['toolName'] === 'string') return data['toolName']
  return undefined
}
