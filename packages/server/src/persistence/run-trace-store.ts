/**
 * RunTraceStore — captures full message exchanges for step-by-step run replay.
 *
 * This is a SEPARATE store from RunStore. RunStore tracks run lifecycle;
 * RunTraceStore captures the detailed step-by-step trace of each run for
 * debugging and replay purposes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceStep {
  stepIndex: number
  /** When this step occurred (epoch ms) */
  timestamp: number
  /** The role/type of this step */
  type:
    | 'user_input'
    | 'llm_request'
    | 'llm_response'
    | 'tool_call'
    | 'tool_result'
    | 'system'
    | 'output'
  /** The actual content/payload */
  content: unknown
  /** Optional metadata (model used, token count, tool name, etc.) */
  metadata?: Record<string, unknown>
  /** Duration of this step in ms (for LLM calls and tool calls) */
  durationMs?: number
}

export interface RunTrace {
  runId: string
  agentId: string
  steps: TraceStep[]
  startedAt: number
  completedAt?: number
  totalSteps: number
}

export interface TraceStepDistribution {
  user_input: number
  llm_request: number
  llm_response: number
  tool_call: number
  tool_result: number
  system: number
  output: number
}

export interface RunTraceStore {
  /** Start a new trace for a run */
  startTrace(runId: string, agentId: string): void

  /** Add a step to the trace */
  addStep(runId: string, step: Omit<TraceStep, 'stepIndex'>): void

  /** Complete the trace */
  completeTrace(runId: string): void

  /** Get the full trace */
  getTrace(runId: string): RunTrace | null

  /** Get a range of steps (for paginated replay) */
  getSteps(runId: string, from: number, to: number): TraceStep[]

  /** Delete a trace */
  deleteTrace(runId: string): void
}

// ---------------------------------------------------------------------------
// In-Memory Implementation
// ---------------------------------------------------------------------------

export interface InMemoryRunTraceStoreOptions {
  /** Maximum number of steps per trace (default: 1000) */
  maxStepsPerTrace?: number
  /** Maximum number of traces retained in memory (default: 10_000). Use `Infinity` to opt out. */
  maxTraces?: number
}

const DEFAULT_MAX_STEPS_PER_TRACE = 1_000
const DEFAULT_MAX_TRACES = 10_000

function attachRetentionMetadata(
  target: object,
  limits: { maxStepsPerTrace: number; maxTraces: number },
  explicitUnbounded: boolean,
): void {
  Object.defineProperty(target, '__dzupagentRetention', {
    value: {
      ...limits,
      explicitUnbounded,
    },
    configurable: true,
    enumerable: false,
    writable: true,
  })
}

function warnIfExplicitlyUnbounded(limitName: string): void {
  console.warn(
    `[InMemoryRunTraceStore] ${limitName} is configured as unbounded. ` +
      'This is intended for explicit development/test opt-out only.',
  )
}

export class InMemoryRunTraceStore implements RunTraceStore {
  private readonly traces = new Map<string, RunTrace>()
  private readonly traceOrder: string[] = []
  private readonly maxSteps: number
  private readonly maxTraces: number

  constructor(options?: InMemoryRunTraceStoreOptions) {
    if (options?.maxStepsPerTrace === Number.POSITIVE_INFINITY) {
      warnIfExplicitlyUnbounded('maxStepsPerTrace')
    }
    if (options?.maxTraces === Number.POSITIVE_INFINITY) {
      warnIfExplicitlyUnbounded('maxTraces')
    }

    this.maxSteps = options?.maxStepsPerTrace ?? DEFAULT_MAX_STEPS_PER_TRACE
    this.maxTraces = options?.maxTraces ?? DEFAULT_MAX_TRACES
    attachRetentionMetadata(this, this.getRetentionLimits(), Boolean(
      options?.maxStepsPerTrace === Number.POSITIVE_INFINITY ||
      options?.maxTraces === Number.POSITIVE_INFINITY,
    ))
  }

  getRetentionLimits(): { maxStepsPerTrace: number; maxTraces: number } {
    return {
      maxStepsPerTrace: this.maxSteps,
      maxTraces: this.maxTraces,
    }
  }

  startTrace(runId: string, agentId: string): void {
    if (!this.traces.has(runId)) {
      this.traceOrder.push(runId)
    }
    this.traces.set(runId, {
      runId,
      agentId,
      steps: [],
      startedAt: Date.now(),
      totalSteps: 0,
    })
    this.enforceTraceLimit()
  }

  addStep(runId: string, step: Omit<TraceStep, 'stepIndex'>): void {
    const trace = this.traces.get(runId)
    if (!trace) return

    if (trace.steps.length >= this.maxSteps) return

    const fullStep: TraceStep = {
      ...step,
      stepIndex: trace.totalSteps,
    }

    trace.steps.push(fullStep)
    trace.totalSteps = trace.steps.length
  }

  completeTrace(runId: string): void {
    const trace = this.traces.get(runId)
    if (!trace) return
    trace.completedAt = Date.now()
  }

  getTrace(runId: string): RunTrace | null {
    return this.traces.get(runId) ?? null
  }

  getSteps(runId: string, from: number, to: number): TraceStep[] {
    const trace = this.traces.get(runId)
    if (!trace) return []

    const clampedFrom = Math.max(0, from)
    const clampedTo = Math.min(trace.steps.length, to)

    if (clampedFrom >= clampedTo) return []

    return trace.steps.slice(clampedFrom, clampedTo)
  }

  deleteTrace(runId: string): void {
    this.traces.delete(runId)
    const idx = this.traceOrder.indexOf(runId)
    if (idx >= 0) this.traceOrder.splice(idx, 1)
  }

  private enforceTraceLimit(): void {
    if (!Number.isFinite(this.maxTraces)) return
    while (this.traceOrder.length > this.maxTraces) {
      const evictedRunId = this.traceOrder.shift()
      if (!evictedRunId) break
      this.traces.delete(evictedRunId)
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: compute type distribution from steps
// ---------------------------------------------------------------------------

export function computeStepDistribution(steps: TraceStep[]): TraceStepDistribution {
  const dist: TraceStepDistribution = {
    user_input: 0,
    llm_request: 0,
    llm_response: 0,
    tool_call: 0,
    tool_result: 0,
    system: 0,
    output: 0,
  }

  for (const step of steps) {
    dist[step.type]++
  }

  return dist
}
