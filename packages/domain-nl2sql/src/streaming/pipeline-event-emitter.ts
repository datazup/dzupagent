/**
 * Typed event emitter for streaming NL2SQL pipeline progress to consumers.
 *
 * Pipeline nodes can optionally emit events through this emitter to
 * provide real-time progress updates (e.g., for SSE streaming).
 * The emitter is fully optional — nodes that receive it as `undefined`
 * simply skip event emission, preserving backward compatibility.
 *
 * This is the canonical implementation, replacing `@nl2sql/pipeline`'s
 * version. All consumers should import from `@dzipagent/domain-nl2sql`.
 *
 * @module @dzipagent/domain-nl2sql/streaming
 */

import { EventEmitter } from 'node:events'

// ── Event payload types ──────────────────────────────────────────────────

export interface StageStartEvent {
  stage: string
  status: 'start'
  timestamp: string
}

export interface StageCompleteEvent {
  stage: string
  status: 'complete'
  duration_ms: number
  timestamp: string
  data?: Record<string, unknown>
}

export interface SQLChunkEvent {
  stage: string
  status: 'sql_chunk'
  timestamp: string
  data: {
    sql: string
    explanation: string | null
    tablesUsed: string[]
    confidence: number
  }
}

export interface ResultRowEvent {
  stage: string
  status: 'result'
  timestamp: string
  data: {
    columns: string[]
    rows: Record<string, unknown>[]
    rowCount: number
    truncated: boolean
  }
}

export interface PipelineErrorEvent {
  stage: string
  status: 'error'
  timestamp: string
  data: {
    message: string
    code: string
  }
}

export interface PipelineDoneEvent {
  stage: string
  status: 'done'
  timestamp: string
  data: {
    totalDuration_ms: number
    stagesCompleted: number
  }
}

/** Union of all pipeline event payloads. */
export type PipelineEvent =
  | StageStartEvent
  | StageCompleteEvent
  | SQLChunkEvent
  | ResultRowEvent
  | PipelineErrorEvent
  | PipelineDoneEvent

/** Map of event names to their payload types. */
export interface PipelineEventMap {
  'stage:start': StageStartEvent
  'stage:complete': StageCompleteEvent
  'sql:chunk': SQLChunkEvent
  'result:row': ResultRowEvent
  error: PipelineErrorEvent
  done: PipelineDoneEvent
}

/** Valid event names that can be emitted. */
export type PipelineEventName = keyof PipelineEventMap

// ── PipelineEventEmitter class ───────────────────────────────────────────

/**
 * Typed event emitter for NL2SQL pipeline events.
 *
 * Provides type-safe `emit()` and `on()` methods for all pipeline events.
 * This class is designed to be created per-request and passed into the
 * pipeline graph. SSE controllers subscribe to events and forward them
 * to the HTTP response stream.
 *
 * @example
 * ```ts
 * const emitter = new PipelineEventEmitter()
 *
 * emitter.on('stage:complete', (event) => {
 *   console.log(`Stage ${event.stage} completed in ${event.duration_ms}ms`)
 * })
 *
 * emitter.emitStageStart('relevance_gate')
 * // ... node does work ...
 * emitter.emitStageComplete('relevance_gate', 234)
 * ```
 */
export class PipelineEventEmitter {
  private readonly _emitter = new EventEmitter()
  private _stagesCompleted = 0
  private _aborted = false

  /** Whether the pipeline has been aborted (e.g., client disconnect). */
  get aborted(): boolean {
    return this._aborted
  }

  /** Number of stages that have emitted 'stage:complete'. */
  get stagesCompleted(): number {
    return this._stagesCompleted
  }

  /**
   * Subscribe to a typed pipeline event.
   */
  on<K extends PipelineEventName>(
    event: K,
    listener: (payload: PipelineEventMap[K]) => void,
  ): this {
    this._emitter.on(event, listener)
    return this
  }

  /**
   * Subscribe to a typed pipeline event (fires once then auto-removes).
   */
  once<K extends PipelineEventName>(
    event: K,
    listener: (payload: PipelineEventMap[K]) => void,
  ): this {
    this._emitter.once(event, listener)
    return this
  }

  /**
   * Remove a specific listener for an event.
   */
  off<K extends PipelineEventName>(
    event: K,
    listener: (payload: PipelineEventMap[K]) => void,
  ): this {
    this._emitter.off(event, listener)
    return this
  }

  /**
   * Remove all listeners, optionally for a specific event.
   */
  removeAllListeners(event?: PipelineEventName): this {
    if (event) {
      this._emitter.removeAllListeners(event)
    } else {
      this._emitter.removeAllListeners()
    }
    return this
  }

  /**
   * Signal that the pipeline should abort (e.g., client disconnected).
   * Nodes should check `emitter.aborted` periodically.
   */
  abort(): void {
    this._aborted = true
  }

  // ── Convenience emit methods ─────────────────────────────────────────

  /** Emit a stage start event. */
  emitStageStart(stage: string): void {
    const payload: StageStartEvent = {
      stage,
      status: 'start',
      timestamp: new Date().toISOString(),
    }
    this._emitter.emit('stage:start', payload)
  }

  /** Emit a stage completion event. */
  emitStageComplete(
    stage: string,
    duration_ms: number,
    data?: Record<string, unknown>,
  ): void {
    this._stagesCompleted++
    const payload: StageCompleteEvent = {
      stage,
      status: 'complete',
      duration_ms,
      timestamp: new Date().toISOString(),
      ...(data ? { data } : {}),
    }
    this._emitter.emit('stage:complete', payload)
  }

  /** Emit a SQL generation result event. */
  emitSQL(
    stage: string,
    sql: string,
    explanation: string | null,
    tablesUsed: string[],
    confidence: number,
  ): void {
    const payload: SQLChunkEvent = {
      stage,
      status: 'sql_chunk',
      timestamp: new Date().toISOString(),
      data: { sql, explanation, tablesUsed, confidence },
    }
    this._emitter.emit('sql:chunk', payload)
  }

  /** Emit a query result event. */
  emitResult(
    stage: string,
    columns: string[],
    rows: Record<string, unknown>[],
    rowCount: number,
    truncated: boolean,
  ): void {
    const payload: ResultRowEvent = {
      stage,
      status: 'result',
      timestamp: new Date().toISOString(),
      data: { columns, rows, rowCount, truncated },
    }
    this._emitter.emit('result:row', payload)
  }

  /** Emit a pipeline error event. */
  emitError(stage: string, message: string, code: string): void {
    const payload: PipelineErrorEvent = {
      stage,
      status: 'error',
      timestamp: new Date().toISOString(),
      data: { message, code },
    }
    this._emitter.emit('error', payload)
  }

  /** Emit the final done event. */
  emitDone(totalDuration_ms: number): void {
    const payload: PipelineDoneEvent = {
      stage: 'pipeline',
      status: 'done',
      timestamp: new Date().toISOString(),
      data: { totalDuration_ms, stagesCompleted: this._stagesCompleted },
    }
    this._emitter.emit('done', payload)
  }
}
