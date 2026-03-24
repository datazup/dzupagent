/**
 * Pipeline executor with DAG dependency resolution, conditional phases,
 * retry strategies, per-phase timeouts, and checkpoint support.
 */

export interface ExecutorConfig {
  /** Default timeout per phase in ms (default: 120_000) */
  defaultTimeoutMs: number
  /** Default max retries per phase (default: 0) */
  defaultMaxRetries: number
  /** Checkpoint function called after each successful phase */
  onCheckpoint?: (phaseId: string, state: Record<string, unknown>) => Promise<void>
  /** Progress callback */
  onProgress?: (phaseId: string, progress: number) => void
}

export interface PhaseConfig {
  id: string
  name: string
  /** Execute this phase */
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Condition to run this phase (default: always run) */
  condition?: (state: Record<string, unknown>) => boolean
  /** Phase IDs that must complete before this one */
  dependsOn?: string[]
  /** Max retries for this phase (default: executor default) */
  maxRetries?: number
  /** Timeout for this phase in ms (default: executor default) */
  timeoutMs?: number
  /** Retry strategy */
  retryStrategy?: 'immediate' | 'backoff'
}

export interface PhaseResult {
  phaseId: string
  status: 'completed' | 'skipped' | 'failed' | 'timeout'
  durationMs: number
  retries: number
  error?: string
  output?: Record<string, unknown>
}

export interface PipelineExecutionResult {
  status: 'completed' | 'failed'
  phases: PhaseResult[]
  totalDurationMs: number
  state: Record<string, unknown>
}

const DEFAULT_CONFIG: ExecutorConfig = {
  defaultTimeoutMs: 120_000,
  defaultMaxRetries: 0,
}

/**
 * Topologically sort phases by their dependsOn relationships.
 * Throws if a cycle is detected.
 */
function topoSort(phases: PhaseConfig[]): PhaseConfig[] {
  const byId = new Map(phases.map(p => [p.id, p]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const sorted: PhaseConfig[] = []

  function visit(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Cycle detected involving phase "${id}"`)
    visiting.add(id)
    const phase = byId.get(id)
    if (!phase) throw new Error(`Unknown dependency phase "${id}"`)
    for (const dep of phase.dependsOn ?? []) {
      visit(dep)
    }
    visiting.delete(id)
    visited.add(id)
    sorted.push(phase)
  }

  for (const phase of phases) visit(phase.id)
  return sorted
}

/** Execute a function with an AbortSignal-based timeout. */
async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<{ result: T; timedOut: false } | { timedOut: true }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(new Error('Phase timeout')))
      }),
    ])
    return { result, timedOut: false }
  } catch (err) {
    if (ac.signal.aborted) return { timedOut: true }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000)
}

/**
 * Execute a pipeline of phases with dependency resolution, conditions,
 * retries, and timeouts.
 */
export class PipelineExecutor {
  private readonly config: ExecutorConfig

  constructor(config?: Partial<ExecutorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async execute(
    phases: PhaseConfig[],
    initialState: Record<string, unknown>,
  ): Promise<PipelineExecutionResult> {
    const pipelineStart = Date.now()
    const sorted = topoSort(phases)
    const results: PhaseResult[] = []
    const completed = new Set<string>()
    let state = { ...initialState }

    for (const phase of sorted) {
      const phaseStart = Date.now()

      // Check dependencies all completed
      const unmetDeps = (phase.dependsOn ?? []).filter(d => !completed.has(d))
      if (unmetDeps.length > 0) {
        results.push({
          phaseId: phase.id,
          status: 'skipped',
          durationMs: 0,
          retries: 0,
          error: `Unmet dependencies: ${unmetDeps.join(', ')}`,
        })
        continue
      }

      // Check condition
      if (phase.condition && !phase.condition(state)) {
        results.push({
          phaseId: phase.id,
          status: 'skipped',
          durationMs: Date.now() - phaseStart,
          retries: 0,
        })
        // Mark skipped phases as "completed" so dependents can still run
        completed.add(phase.id)
        state[`__phase_${phase.id}_skipped`] = true
        this.config.onProgress?.(phase.id, 1)
        continue
      }

      const maxRetries = phase.maxRetries ?? this.config.defaultMaxRetries
      const timeoutMs = phase.timeoutMs ?? this.config.defaultTimeoutMs
      let lastError: string | undefined
      let succeeded = false
      let retries = 0
      let output: Record<string, unknown> | undefined

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          retries = attempt
          if (phase.retryStrategy === 'backoff') {
            await new Promise(r => setTimeout(r, backoffDelay(attempt - 1)))
          }
        }

        this.config.onProgress?.(phase.id, attempt / (maxRetries + 1))

        try {
          const result = await withTimeout(() => phase.execute(state), timeoutMs)

          if (result.timedOut) {
            lastError = `Phase "${phase.name}" timed out after ${timeoutMs}ms`
            continue
          }

          output = result.result
          state = { ...state, ...output }
          state[`__phase_${phase.id}_completed`] = true
          succeeded = true
          break
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }

      const durationMs = Date.now() - phaseStart

      if (succeeded) {
        completed.add(phase.id)
        results.push({ phaseId: phase.id, status: 'completed', durationMs, retries, output })
        this.config.onProgress?.(phase.id, 1)

        if (this.config.onCheckpoint) {
          await this.config.onCheckpoint(phase.id, state)
        }
      } else {
        const isTimeout = lastError?.includes('timed out')
        results.push({
          phaseId: phase.id,
          status: isTimeout ? 'timeout' : 'failed',
          durationMs,
          retries,
          error: lastError,
        })

        return {
          status: 'failed',
          phases: results,
          totalDurationMs: Date.now() - pipelineStart,
          state,
        }
      }
    }

    return {
      status: 'completed',
      phases: results,
      totalDurationMs: Date.now() - pipelineStart,
      state,
    }
  }
}
