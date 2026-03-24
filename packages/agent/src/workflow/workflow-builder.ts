/**
 * Fluent workflow builder for general-purpose multi-step agent pipelines.
 *
 * Supports sequential steps, parallel fan-out/merge, conditional branching,
 * and suspend/resume for human-in-the-loop flows.
 *
 * @example
 * ```ts
 * const workflow = createWorkflow({ id: 'feature-gen' })
 *   .then(planStep)
 *   .suspend('plan_review')
 *   .parallel([genBackend, genFrontend, genTests])
 *   .then(validateStep)
 *   .branch(
 *     (s) => s.valid ? 'publish' : 'fix',
 *     { publish: [publishStep], fix: [fixStep, validateStep] }
 *   )
 *   .build()
 *
 * const result = await workflow.run({ spec: '...' })
 * ```
 */
import type {
  WorkflowStep,
  WorkflowNode,
  MergeStrategy,
  WorkflowContext,
  WorkflowEvent,
} from './workflow-types.js'

export interface WorkflowConfig {
  id: string
  description?: string
}

export class WorkflowBuilder {
  private nodes: WorkflowNode[] = []

  constructor(private config: WorkflowConfig) {}

  /** Add a sequential step */
  then(step: WorkflowStep): this {
    this.nodes.push({ type: 'step', step })
    return this
  }

  /** Run multiple steps in parallel and merge results */
  parallel(steps: WorkflowStep[], mergeStrategy?: MergeStrategy): this {
    this.nodes.push({
      type: 'parallel',
      steps,
      mergeStrategy: mergeStrategy ?? 'merge-objects',
    })
    return this
  }

  /** Conditional branching based on current state */
  branch(
    condition: (state: Record<string, unknown>) => string,
    branches: Record<string, WorkflowStep[]>,
  ): this {
    this.nodes.push({ type: 'branch', condition, branches })
    return this
  }

  /** Suspend execution until external resume (human-in-the-loop) */
  suspend(reason: string): this {
    this.nodes.push({ type: 'suspend', reason })
    return this
  }

  /** Build the workflow into an executable CompiledWorkflow */
  build(): CompiledWorkflow {
    return new CompiledWorkflow(this.config, [...this.nodes])
  }
}

/**
 * Compiled workflow — ready for execution.
 *
 * Runs nodes sequentially, handling parallel fan-out, branching,
 * and suspend/resume. Emits events via an async generator.
 */
export class CompiledWorkflow {
  constructor(
    readonly config: WorkflowConfig,
    private nodes: WorkflowNode[],
  ) {}

  /** Execute the workflow with initial state */
  async run(
    initialState: Record<string, unknown>,
    options?: { signal?: AbortSignal; onEvent?: (event: WorkflowEvent) => void },
  ): Promise<Record<string, unknown>> {
    const ctx: WorkflowContext = {
      workflowId: this.config.id,
      state: { ...initialState },
      signal: options?.signal,
    }
    const emit = options?.onEvent ?? (() => {})
    const startTime = Date.now()

    try {
      for (const node of this.nodes) {
        if (options?.signal?.aborted) break
        await this.executeNode(node, ctx, emit)
      }

      emit({ type: 'workflow:completed', durationMs: Date.now() - startTime })
      return ctx.state
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'workflow:failed', error: message })
      throw err
    }
  }

  /** Stream workflow events as an async generator */
  async *stream(
    initialState: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<WorkflowEvent> {
    const events: WorkflowEvent[] = []
    let resolveNext: (() => void) | null = null

    const onEvent = (event: WorkflowEvent) => {
      events.push(event)
      resolveNext?.()
    }

    // Run workflow in background
    const runPromise = this.run(initialState, { signal: options?.signal, onEvent })
      .catch((err: unknown) => {
        onEvent({
          type: 'workflow:failed',
          error: err instanceof Error ? err.message : String(err),
        })
      })

    // Yield events as they arrive
    while (true) {
      if (events.length > 0) {
        const event = events.shift()!
        yield event
        if (event.type === 'workflow:completed' || event.type === 'workflow:failed') {
          break
        }
      } else {
        await new Promise<void>(resolve => { resolveNext = resolve })
      }
    }

    await runPromise
  }

  private async executeNode(
    node: WorkflowNode,
    ctx: WorkflowContext,
    emit: (event: WorkflowEvent) => void,
  ): Promise<void> {
    switch (node.type) {
      case 'step': {
        const start = Date.now()
        emit({ type: 'step:started', stepId: node.step.id })
        try {
          const result = await node.step.execute(ctx.state, ctx) as Record<string, unknown> | undefined
          if (result && typeof result === 'object') {
            Object.assign(ctx.state, result)
          }
          emit({ type: 'step:completed', stepId: node.step.id, durationMs: Date.now() - start })
        } catch (err) {
          emit({ type: 'step:failed', stepId: node.step.id, error: err instanceof Error ? err.message : String(err) })
          throw err
        }
        break
      }

      case 'parallel': {
        const stepIds = node.steps.map(s => s.id)
        const start = Date.now()
        emit({ type: 'parallel:started', stepIds })

        const results = await Promise.all(
          node.steps.map(async (step) => {
            emit({ type: 'step:started', stepId: step.id })
            const stepStart = Date.now()
            try {
              const result = await step.execute(ctx.state, ctx)
              emit({ type: 'step:completed', stepId: step.id, durationMs: Date.now() - stepStart })
              return result
            } catch (err) {
              emit({ type: 'step:failed', stepId: step.id, error: err instanceof Error ? err.message : String(err) })
              throw err
            }
          }),
        )

        // Merge results
        this.mergeResults(ctx.state, results as Record<string, unknown>[], node.mergeStrategy)
        emit({ type: 'parallel:completed', stepIds, durationMs: Date.now() - start })
        break
      }

      case 'branch': {
        const selected = node.condition(ctx.state)
        emit({ type: 'branch:evaluated', condition: 'custom', selected })

        const branchSteps = node.branches[selected]
        if (!branchSteps) {
          throw new Error(`Branch "${selected}" not found in workflow "${ctx.workflowId}"`)
        }

        for (const step of branchSteps) {
          await this.executeNode({ type: 'step', step }, ctx, emit)
        }
        break
      }

      case 'suspend': {
        emit({ type: 'suspended', reason: node.reason })
        // In a real implementation, this would checkpoint state and return.
        // For now, we just emit the event. LangGraph integration handles actual suspension.
        break
      }
    }
  }

  private mergeResults(
    state: Record<string, unknown>,
    results: Record<string, unknown>[],
    strategy: MergeStrategy,
  ): void {
    switch (strategy) {
      case 'merge-objects':
        for (const result of results) {
          if (result && typeof result === 'object') {
            Object.assign(state, result)
          }
        }
        break
      case 'last-wins':
        if (results.length > 0) {
          const last = results[results.length - 1]
          if (last && typeof last === 'object') Object.assign(state, last)
        }
        break
      case 'concat-arrays':
        state['parallelResults'] = results
        break
    }
  }
}

/** Factory function for creating workflows */
export function createWorkflow(config: WorkflowConfig): WorkflowBuilder {
  return new WorkflowBuilder(config)
}
