/**
 * Adapter Workflow Builder -- Declarative workflow DSL for multi-step
 * adapter orchestrations with provider-per-step routing.
 *
 * Supports sequential steps, parallel fan-out, conditional branching,
 * state transforms, per-step retries, and preferred-provider routing.
 *
 * @example
 * ```ts
 * const workflow = defineWorkflow({ id: 'incident-response' })
 *   .step({ id: 'detect', prompt: 'Detect the issue', tags: ['reasoning'] })
 *   .step({ id: 'diagnose', prompt: 'Diagnose: {{prev}}', tags: ['reasoning'] })
 *   .parallel([
 *     { id: 'fix-db', prompt: 'Fix DB: {{state.diagnose}}', tags: ['execution'] },
 *     { id: 'fix-api', prompt: 'Fix API: {{state.diagnose}}', tags: ['execution'] },
 *   ])
 *   .step({ id: 'verify', prompt: 'Verify fixes: {{prev}}', tags: ['testing'] })
 *   .build()
 *
 * const result = await workflow.run(registry, { initialState: { context: '...' } })
 * ```
 */

import type { DzipEventBus } from '@dzipagent/core'

import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the adapter workflow. */
export interface AdapterWorkflowConfig {
  id: string
  description?: string
}

/** Configuration for a single workflow step. */
export interface AdapterStepConfig {
  /** Step identifier */
  id: string
  /** Prompt template. Can use {{prev}} for previous step result and {{state.key}} for state access */
  prompt: string
  /** Tags for routing */
  tags?: string[]
  /** Preferred provider for this step */
  preferredProvider?: AdapterProviderId
  /** Whether this step requires reasoning */
  requiresReasoning?: boolean
  /** Whether this step requires execution */
  requiresExecution?: boolean
  /** Max retries on failure. Default 0 */
  maxRetries?: number
  /** System prompt override for this step */
  systemPrompt?: string
  /** Working directory override */
  workingDirectory?: string
  /** Max turns for the adapter */
  maxTurns?: number
}

/** Result of the entire workflow. */
export interface AdapterWorkflowResult {
  workflowId: string
  success: boolean
  finalState: Record<string, unknown>
  stepResults: AdapterStepResult[]
  totalDurationMs: number
}

/** Result of a single step. */
export interface AdapterStepResult {
  stepId: string
  result: string
  providerId: AdapterProviderId
  success: boolean
  durationMs: number
  retries: number
  error?: string
}

/** Condition function for branching. Returns the branch key to follow. */
export type BranchCondition = (state: Record<string, unknown>) => string

/** Merge strategy for parallel step results. */
export type ParallelMergeStrategy = 'merge' | 'concat' | 'last-wins'

/** Events emitted during workflow execution. */
export type AdapterWorkflowEvent =
  | { type: 'workflow:started'; workflowId: string }
  | { type: 'step:started'; workflowId: string; stepId: string }
  | { type: 'step:completed'; workflowId: string; stepId: string; durationMs: number; providerId: string }
  | { type: 'step:failed'; workflowId: string; stepId: string; error: string; retryCount: number }
  | { type: 'step:retrying'; workflowId: string; stepId: string; attempt: number; maxRetries: number }
  | { type: 'parallel:started'; workflowId: string; stepIds: string[] }
  | { type: 'parallel:completed'; workflowId: string; stepIds: string[]; durationMs: number }
  | { type: 'branch:evaluated'; workflowId: string; selected: string }
  | { type: 'workflow:completed'; workflowId: string; durationMs: number }
  | { type: 'workflow:failed'; workflowId: string; error: string }

// ---------------------------------------------------------------------------
// Internal node types
// ---------------------------------------------------------------------------

type AdapterWorkflowNode =
  | { type: 'step'; config: AdapterStepConfig }
  | { type: 'parallel'; steps: AdapterStepConfig[]; mergeStrategy: ParallelMergeStrategy }
  | { type: 'branch'; condition: BranchCondition; branches: Record<string, AdapterStepConfig[]> }
  | { type: 'transform'; id: string; fn: (state: Record<string, unknown>) => Record<string, unknown> }

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve template variables in a prompt string.
 *
 * Supported patterns:
 * - `{{prev}}` -- replaced with the previous step's result
 * - `{{state.key}}` -- replaced with a value from accumulated state
 */
function resolveTemplate(
  template: string,
  state: Record<string, unknown>,
  prevResult?: string,
): string {
  let resolved = template

  // Replace {{prev}} with previous step result
  resolved = resolved.replace(/\{\{prev\}\}/g, prevResult ?? '')

  // Replace {{state.key}} with state values (supports dotted paths)
  resolved = resolved.replace(/\{\{state\.([a-zA-Z0-9_.]+)\}\}/g, (_match, key: string) => {
    const value = resolveStatePath(state, key)
    if (value === undefined) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })

  return resolved
}

/**
 * Resolve a dotted path against a state object.
 * E.g. "foo.bar" resolves state.foo.bar.
 */
function resolveStatePath(state: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = state

  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function isCompletedEvent(event: AgentEvent): event is AgentCompletedEvent {
  return event.type === 'adapter:completed'
}

function isFailedEvent(event: AgentEvent): event is AgentFailedEvent {
  return event.type === 'adapter:failed'
}

// ---------------------------------------------------------------------------
// AdapterWorkflow (executable)
// ---------------------------------------------------------------------------

/** Options for running a workflow. */
export interface AdapterWorkflowRunOptions {
  initialState?: Record<string, unknown>
  signal?: AbortSignal
  eventBus?: DzipEventBus
  onEvent?: (event: AdapterWorkflowEvent) => void
}

/**
 * Executable adapter workflow.
 *
 * Created by `AdapterWorkflowBuilder.build()`. Runs nodes sequentially,
 * delegating adapter calls to the registry with automatic fallback.
 */
export class AdapterWorkflow {
  constructor(
    private readonly workflowConfig: AdapterWorkflowConfig,
    private readonly nodes: AdapterWorkflowNode[],
  ) {}

  /** The workflow identifier. */
  get id(): string {
    return this.workflowConfig.id
  }

  /**
   * Execute the workflow using the given registry.
   *
   * Steps are executed in declaration order. Each step's result is stored
   * in the accumulated state under its step ID. The `{{prev}}` template
   * variable always refers to the most recent step result.
   */
  async run(
    registry: AdapterRegistry,
    options?: AdapterWorkflowRunOptions,
  ): Promise<AdapterWorkflowResult> {
    const state: Record<string, unknown> = { ...(options?.initialState ?? {}) }
    const stepResults: AdapterStepResult[] = []
    const emit = options?.onEvent ?? (() => {})
    const overallStart = Date.now()
    let prevResult: string | undefined

    emit({ type: 'workflow:started', workflowId: this.workflowConfig.id })

    try {
      for (const node of this.nodes) {
        this.throwIfAborted(options?.signal)

        switch (node.type) {
          case 'step': {
            const result = await this.executeStep(
              registry,
              node.config,
              state,
              prevResult,
              emit,
              options?.signal,
            )
            stepResults.push(result)
            state[node.config.id] = result.result
            if (result.success) {
              prevResult = result.result
            }
            if (!result.success) {
              throw new Error(`Step "${node.config.id}" failed: ${result.error ?? 'unknown error'}`)
            }
            break
          }

          case 'parallel': {
            const results = await this.executeParallel(
              registry,
              node.steps,
              node.mergeStrategy,
              state,
              prevResult,
              emit,
              options?.signal,
            )
            stepResults.push(...results)

            // Merge into state based on strategy
            this.mergeParallelResults(state, results, node.mergeStrategy)

            // Update prevResult to a summary of parallel results
            const successResults = results.filter((r) => r.success).map((r) => r.result)
            prevResult = successResults.join('\n\n')
            break
          }

          case 'branch': {
            const selected = node.condition(state)
            emit({ type: 'branch:evaluated', workflowId: this.workflowConfig.id, selected })

            const branchSteps = node.branches[selected]
            if (!branchSteps) {
              throw new Error(
                `Branch "${selected}" not found in workflow "${this.workflowConfig.id}". ` +
                  `Available branches: ${Object.keys(node.branches).join(', ')}`,
              )
            }

            for (const stepConfig of branchSteps) {
              this.throwIfAborted(options?.signal)
              const result = await this.executeStep(
                registry,
                stepConfig,
                state,
                prevResult,
                emit,
                options?.signal,
              )
              stepResults.push(result)
              state[stepConfig.id] = result.result
              if (result.success) {
                prevResult = result.result
              }
              if (!result.success) {
                throw new Error(
                  `Step "${stepConfig.id}" in branch "${selected}" failed: ${result.error ?? 'unknown error'}`,
                )
              }
            }
            break
          }

          case 'transform': {
            const transformed = node.fn(state)
            Object.assign(state, transformed)
            break
          }
        }
      }

      const totalDurationMs = Date.now() - overallStart
      emit({ type: 'workflow:completed', workflowId: this.workflowConfig.id, durationMs: totalDurationMs })

      return {
        workflowId: this.workflowConfig.id,
        success: true,
        finalState: state,
        stepResults,
        totalDurationMs,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'workflow:failed', workflowId: this.workflowConfig.id, error: message })

      return {
        workflowId: this.workflowConfig.id,
        success: false,
        finalState: state,
        stepResults,
        totalDurationMs: Date.now() - overallStart,
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: step execution
  // -----------------------------------------------------------------------

  private async executeStep(
    registry: AdapterRegistry,
    config: AdapterStepConfig,
    state: Record<string, unknown>,
    prevResult: string | undefined,
    emit: (event: AdapterWorkflowEvent) => void,
    signal?: AbortSignal,
  ): Promise<AdapterStepResult> {
    const maxRetries = config.maxRetries ?? 0
    let lastError: string | undefined
    let attempt = 0

    while (attempt <= maxRetries) {
      this.throwIfAborted(signal)

      if (attempt > 0) {
        emit({
          type: 'step:retrying',
          workflowId: this.workflowConfig.id,
          stepId: config.id,
          attempt,
          maxRetries,
        })
      }

      emit({ type: 'step:started', workflowId: this.workflowConfig.id, stepId: config.id })
      const stepStart = Date.now()

      try {
        const resolvedPrompt = resolveTemplate(config.prompt, state, prevResult)

        const task: TaskDescriptor = {
          prompt: resolvedPrompt,
          tags: config.tags ?? [],
          preferredProvider: config.preferredProvider,
          requiresReasoning: config.requiresReasoning,
          requiresExecution: config.requiresExecution,
          workingDirectory: config.workingDirectory,
        }

        const input: AgentInput = {
          prompt: resolvedPrompt,
          systemPrompt: config.systemPrompt,
          workingDirectory: config.workingDirectory,
          maxTurns: config.maxTurns,
          signal,
        }

        const { resultText, providerId } = await this.consumeAdapterEvents(
          registry,
          input,
          task,
          signal,
        )

        const durationMs = Date.now() - stepStart

        emit({
          type: 'step:completed',
          workflowId: this.workflowConfig.id,
          stepId: config.id,
          durationMs,
          providerId,
        })

        return {
          stepId: config.id,
          result: resultText,
          providerId,
          success: true,
          durationMs,
          retries: attempt,
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        lastError = errorMessage
        const durationMs = Date.now() - stepStart

        emit({
          type: 'step:failed',
          workflowId: this.workflowConfig.id,
          stepId: config.id,
          error: errorMessage,
          retryCount: attempt,
        })

        // If we have retries left, continue the loop
        if (attempt < maxRetries) {
          attempt++
          continue
        }

        // No retries left -- return failure
        return {
          stepId: config.id,
          result: '',
          providerId: config.preferredProvider ?? 'claude',
          success: false,
          durationMs,
          retries: attempt,
          error: lastError,
        }
      }
    }

    // Unreachable, but satisfies TypeScript exhaustiveness
    return {
      stepId: config.id,
      result: '',
      providerId: config.preferredProvider ?? 'claude',
      success: false,
      durationMs: 0,
      retries: attempt,
      error: lastError ?? 'Unknown error',
    }
  }

  // -----------------------------------------------------------------------
  // Private: parallel execution
  // -----------------------------------------------------------------------

  private async executeParallel(
    registry: AdapterRegistry,
    steps: AdapterStepConfig[],
    _mergeStrategy: ParallelMergeStrategy,
    state: Record<string, unknown>,
    prevResult: string | undefined,
    emit: (event: AdapterWorkflowEvent) => void,
    signal?: AbortSignal,
  ): Promise<AdapterStepResult[]> {
    const stepIds = steps.map((s) => s.id)
    emit({ type: 'parallel:started', workflowId: this.workflowConfig.id, stepIds })

    const parallelStart = Date.now()

    // Snapshot state so parallel steps don't interfere with each other
    const stateSnapshot = { ...state }

    const settled = await Promise.allSettled(
      steps.map((stepConfig) =>
        this.executeStep(registry, stepConfig, stateSnapshot, prevResult, emit, signal),
      ),
    )

    const results: AdapterStepResult[] = settled.map((outcome, idx) => {
      const stepConfig = steps[idx] as AdapterStepConfig
      if (outcome.status === 'fulfilled') {
        return outcome.value
      }
      // Rejected -- shouldn't normally happen since executeStep catches errors,
      // but handle gracefully
      const errorMessage =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      return {
        stepId: stepConfig.id,
        result: '',
        providerId: stepConfig.preferredProvider ?? 'claude',
        success: false,
        durationMs: 0,
        retries: 0,
        error: errorMessage,
      }
    })

    const parallelDuration = Date.now() - parallelStart
    emit({
      type: 'parallel:completed',
      workflowId: this.workflowConfig.id,
      stepIds,
      durationMs: parallelDuration,
    })

    return results
  }

  // -----------------------------------------------------------------------
  // Private: merge strategies
  // -----------------------------------------------------------------------

  private mergeParallelResults(
    state: Record<string, unknown>,
    results: AdapterStepResult[],
    strategy: ParallelMergeStrategy,
  ): void {
    switch (strategy) {
      case 'merge': {
        // Each step's result is stored under its ID
        for (const result of results) {
          state[result.stepId] = result.result
        }
        break
      }

      case 'concat': {
        // All results stored as an array under 'parallelResults'
        state['parallelResults'] = results.map((r) => ({
          stepId: r.stepId,
          result: r.result,
          success: r.success,
        }))
        // Also store individually
        for (const result of results) {
          state[result.stepId] = result.result
        }
        break
      }

      case 'last-wins': {
        // Last successful result overwrites; individual results still stored
        const lastSuccess = [...results].reverse().find((r) => r.success)
        if (lastSuccess) {
          state['lastResult'] = lastSuccess.result
        }
        for (const result of results) {
          state[result.stepId] = result.result
        }
        break
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: adapter event consumption
  // -----------------------------------------------------------------------

  /**
   * Execute via the registry's fallback chain and extract the final result.
   * Consumes all events from the async generator, returning the result text
   * and the provider that produced it.
   */
  private async consumeAdapterEvents(
    registry: AdapterRegistry,
    input: AgentInput,
    task: TaskDescriptor,
    signal?: AbortSignal,
  ): Promise<{ resultText: string; providerId: AdapterProviderId }> {
    const generator = registry.executeWithFallback(input, task)

    let resultText = ''
    let resultProviderId: AdapterProviderId = 'claude'
    let completed = false
    let lastError: string | undefined

    for await (const event of generator) {
      this.throwIfAborted(signal)

      if (isCompletedEvent(event)) {
        resultText = event.result
        resultProviderId = event.providerId
        completed = true
      } else if (isFailedEvent(event)) {
        lastError = event.error
        resultProviderId = event.providerId
      }
    }

    if (!completed) {
      throw new Error(lastError ?? 'Adapter completed without producing a result')
    }

    return { resultText, providerId: resultProviderId }
  }

  // -----------------------------------------------------------------------
  // Private: abort handling
  // -----------------------------------------------------------------------

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('Workflow execution was aborted')
    }
  }
}

// ---------------------------------------------------------------------------
// AdapterWorkflowBuilder (fluent API)
// ---------------------------------------------------------------------------

/**
 * Fluent builder for constructing adapter workflows.
 *
 * @example
 * ```ts
 * const workflow = defineWorkflow({ id: 'code-review' })
 *   .step({ id: 'analyze', prompt: 'Analyze the code', tags: ['reasoning'] })
 *   .parallel([
 *     { id: 'security', prompt: 'Security review: {{prev}}', tags: ['reasoning'] },
 *     { id: 'perf', prompt: 'Performance review: {{prev}}', tags: ['reasoning'] },
 *   ])
 *   .transform('combine', (state) => ({
 *     ...state,
 *     summary: `Security: ${String(state['security'])}\nPerf: ${String(state['perf'])}`,
 *   }))
 *   .step({ id: 'report', prompt: 'Create report: {{state.summary}}', tags: ['general'] })
 *   .build()
 * ```
 */
export class AdapterWorkflowBuilder {
  private readonly nodes: AdapterWorkflowNode[] = []

  constructor(private readonly config: AdapterWorkflowConfig) {}

  /** Add a sequential step that runs on the best-routed adapter. */
  step(config: AdapterStepConfig): this {
    this.nodes.push({ type: 'step', config })
    return this
  }

  /** Run multiple steps in parallel across different adapters. */
  parallel(steps: AdapterStepConfig[], mergeStrategy?: ParallelMergeStrategy): this {
    this.nodes.push({
      type: 'parallel',
      steps,
      mergeStrategy: mergeStrategy ?? 'merge',
    })
    return this
  }

  /** Conditional branching based on accumulated state. */
  branch(condition: BranchCondition, branches: Record<string, AdapterStepConfig[]>): this {
    this.nodes.push({ type: 'branch', condition, branches })
    return this
  }

  /** Transform state between steps (no adapter call). */
  transform(
    id: string,
    fn: (state: Record<string, unknown>) => Record<string, unknown>,
  ): this {
    this.nodes.push({ type: 'transform', id, fn })
    return this
  }

  /** Build into an executable workflow. */
  build(): AdapterWorkflow {
    return new AdapterWorkflow(this.config, [...this.nodes])
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/** Create a new adapter workflow builder with a fluent API. */
export function defineWorkflow(config: AdapterWorkflowConfig): AdapterWorkflowBuilder {
  return new AdapterWorkflowBuilder(config)
}
