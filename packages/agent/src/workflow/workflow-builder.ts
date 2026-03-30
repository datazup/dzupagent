/**
 * Fluent workflow builder for general-purpose multi-step agent pipelines.
 *
 * Supports sequential steps, parallel fan-out/merge, conditional branching,
 * and suspend/resume for human-in-the-loop flows.
 *
 * The builder compiles workflow nodes into a canonical `PipelineDefinition`
 * and executes via `PipelineRuntime`.
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
import type { PipelineDefinition, PipelineNode } from '@dzipagent/core'
import type {
  WorkflowStep,
  WorkflowNode,
  MergeStrategy,
  WorkflowContext,
  WorkflowEvent,
} from './workflow-types.js'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import type { NodeExecutor, NodeExecutionContext, PipelineRuntimeEvent } from '../pipeline/pipeline-runtime-types.js'

export interface WorkflowConfig {
  id: string
  description?: string
}

interface WorkflowCompilation {
  definition: PipelineDefinition
  predicates: Record<string, (state: Record<string, unknown>) => boolean | string>
  suspendReasons: Map<string, string>
  createNodeExecutor: (
    emit: (event: WorkflowEvent) => void,
    onStateObserved: (state: Record<string, unknown>) => void,
  ) => NodeExecutor
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
 * Compiles to `PipelineDefinition` and executes via `PipelineRuntime`.
 */
export class CompiledWorkflow {
  private readonly compilation: WorkflowCompilation

  constructor(
    readonly config: WorkflowConfig,
    nodes: WorkflowNode[],
  ) {
    this.compilation = compileWorkflow(config, nodes)
  }

  /** Inspect the compiled canonical pipeline definition. */
  toPipelineDefinition(): PipelineDefinition {
    return structuredClone(this.compilation.definition)
  }

  /** Execute the workflow with initial state */
  async run(
    initialState: Record<string, unknown>,
    options?: { signal?: AbortSignal; onEvent?: (event: WorkflowEvent) => void },
  ): Promise<Record<string, unknown>> {
    const emit = options?.onEvent ?? (() => {})
    let latestObservedState: Record<string, unknown> = { ...initialState }
    let pipelineFailure: string | null = null

    const runtime = new PipelineRuntime({
      definition: this.compilation.definition,
      nodeExecutor: this.compilation.createNodeExecutor(emit, (state) => {
        latestObservedState = state
      }),
      // Runtime implementation supports non-boolean branch keys, but the public
      // config type currently narrows predicates to boolean.
      predicates: this.compilation.predicates as Record<string, (state: Record<string, unknown>) => boolean>,
      signal: options?.signal,
      onEvent: (event) => this.handleRuntimeEvent(event, emit, (err) => {
        pipelineFailure = err
      }),
    })

    try {
      const result = await runtime.execute(initialState)
      if (result.state === 'failed') {
        throw new Error(pipelineFailure ?? this.extractFailure(result.nodeResults) ?? 'Workflow execution failed')
      }
      return { ...latestObservedState }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!pipelineFailure) {
        emit({ type: 'workflow:failed', error: message })
      }
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
        if (event.type === 'workflow:completed' || event.type === 'workflow:failed' || event.type === 'suspended') {
          break
        }
      } else {
        await new Promise<void>(resolve => { resolveNext = resolve })
      }
    }

    await runPromise
  }

  private handleRuntimeEvent(
    event: PipelineRuntimeEvent,
    emit: (event: WorkflowEvent) => void,
    onFailure: (error: string) => void,
  ): void {
    switch (event.type) {
      case 'pipeline:completed':
        emit({ type: 'workflow:completed', durationMs: event.totalDurationMs })
        break
      case 'pipeline:failed':
        onFailure(event.error)
        emit({ type: 'workflow:failed', error: event.error })
        break
      case 'pipeline:suspended': {
        const reason = this.compilation.suspendReasons.get(event.nodeId) ?? 'suspended'
        emit({ type: 'suspended', reason })
        break
      }
      default:
        break
    }
  }

  private extractFailure(nodeResults: Map<string, { error?: string }>): string | null {
    for (const result of nodeResults.values()) {
      if (result.error) return result.error
    }
    return null
  }
}

function compileWorkflow(config: WorkflowConfig, nodes: WorkflowNode[]): WorkflowCompilation {
  const pipelineNodes: PipelineNode[] = []
  const edges: PipelineDefinition['edges'] = []
  const predicates: Record<string, (state: Record<string, unknown>) => boolean | string> = {}
  const suspendReasons = new Map<string, string>()
  const handlers = new Map<string, (
    state: Record<string, unknown>,
    ctx: WorkflowContext,
    emit: (event: WorkflowEvent) => void,
  ) => Promise<Record<string, unknown> | undefined>>()

  let nodeSeq = 0
  let transformSeq = 0
  let predicateSeq = 0

  const nextNodeId = (prefix: string): string => `${prefix}_${nodeSeq++}`
  const nextTransformName = (prefix: string): string => `wf_${prefix}_${transformSeq++}`
  const nextPredicateName = (): string => `wf_predicate_${predicateSeq++}`

  const addTransformNode = (
    prefix: string,
    handler: (
      state: Record<string, unknown>,
      ctx: WorkflowContext,
      emit: (event: WorkflowEvent) => void,
    ) => Promise<Record<string, unknown> | undefined>,
    name?: string,
  ): string => {
    const nodeId = nextNodeId(prefix)
    const transformName = nextTransformName(prefix)
    handlers.set(transformName, handler)
    pipelineNodes.push({
      id: nodeId,
      type: 'transform',
      transformName,
      name,
      timeoutMs: 120_000,
    })
    return nodeId
  }

  const appendSequential = (sourceNodeId: string, targetNodeId: string | undefined): void => {
    if (!targetNodeId) return
    edges.push({ type: 'sequential', sourceNodeId, targetNodeId })
  }

  const mergeResults = (
    state: Record<string, unknown>,
    results: Record<string, unknown>[],
    strategy: MergeStrategy,
  ): void => {
    switch (strategy) {
      case 'merge-objects':
        for (const result of results) {
          if (result && typeof result === 'object') {
            Object.assign(state, result)
          }
        }
        break
      case 'last-wins': {
        const last = results[results.length - 1]
        if (last && typeof last === 'object') {
          Object.assign(state, last)
        }
        break
      }
      case 'concat-arrays':
        state['parallelResults'] = results
        break
      default:
        break
    }
  }

  const addStepNode = (step: WorkflowStep, labelPrefix: string): string => {
    return addTransformNode(
      'step',
      async (state, ctx, emit) => {
        const start = Date.now()
        emit({ type: 'step:started', stepId: step.id })
        try {
          const result = await step.execute(state, ctx) as Record<string, unknown> | undefined
          if (result && typeof result === 'object') {
            Object.assign(state, result)
          }
          emit({ type: 'step:completed', stepId: step.id, durationMs: Date.now() - start })
          return result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          emit({ type: 'step:failed', stepId: step.id, error: message })
          throw err
        }
      },
      `${labelPrefix}:${step.id}`,
    )
  }

  const addParallelNode = (
    steps: WorkflowStep[],
    mergeStrategy: MergeStrategy,
  ): string => {
    return addTransformNode(
      'parallel',
      async (state, ctx, emit) => {
        const stepIds = steps.map(s => s.id)
        const start = Date.now()
        emit({ type: 'parallel:started', stepIds })

        const results = await Promise.all(
          steps.map(async (step) => {
            emit({ type: 'step:started', stepId: step.id })
            const stepStart = Date.now()
            try {
              const result = await step.execute(state, ctx) as Record<string, unknown> | undefined
              emit({ type: 'step:completed', stepId: step.id, durationMs: Date.now() - stepStart })
              return result ?? {}
            } catch (err) {
              emit({
                type: 'step:failed',
                stepId: step.id,
                error: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }),
        )

        mergeResults(state, results, mergeStrategy)
        emit({ type: 'parallel:completed', stepIds, durationMs: Date.now() - start })
        return { parallelResults: results }
      },
      'parallel',
    )
  }

  const addBranchNode = (
    condition: (state: Record<string, unknown>) => string,
    branches: Record<string, WorkflowStep[]>,
  ): { nodeId: string; predicateName: string } => {
    const selectionKey = `__wf_branch_selection_${nodeSeq}`
    const predicateName = nextPredicateName()

    predicates[predicateName] = (state) => {
      const selected = state[selectionKey]
      return typeof selected === 'string' ? selected : ''
    }

    const nodeId = addTransformNode(
      'branch',
      async (state, _ctx, emit) => {
        const selected = condition(state)
        emit({ type: 'branch:evaluated', condition: 'custom', selected })
        if (!Object.prototype.hasOwnProperty.call(branches, selected)) {
          throw new Error(`Branch "${selected}" not found in workflow "${config.id}"`)
        }
        state[selectionKey] = selected
        return { [selectionKey]: selected }
      },
      'branch',
    )

    return { nodeId, predicateName }
  }

  const compileStepSequence = (
    steps: WorkflowStep[],
    continuationNodeId: string | undefined,
    sequenceLabel: string,
  ): string | undefined => {
    if (steps.length === 0) {
      return continuationNodeId
    }

    let next = continuationNodeId
    for (let i = steps.length - 1; i >= 0; i--) {
      const stepNodeId = addStepNode(steps[i]!, sequenceLabel)
      appendSequential(stepNodeId, next)
      next = stepNodeId
    }
    return next
  }

  let nextNodeIdInFlow: string | undefined

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!

    switch (node.type) {
      case 'step': {
        const stepNodeId = addStepNode(node.step, 'linear')
        appendSequential(stepNodeId, nextNodeIdInFlow)
        nextNodeIdInFlow = stepNodeId
        break
      }

      case 'parallel': {
        const parallelNodeId = addParallelNode(node.steps, node.mergeStrategy)
        appendSequential(parallelNodeId, nextNodeIdInFlow)
        nextNodeIdInFlow = parallelNodeId
        break
      }

      case 'suspend': {
        const suspendNodeId = nextNodeId('suspend')
        pipelineNodes.push({
          id: suspendNodeId,
          type: 'suspend',
          name: `suspend:${node.reason}`,
          timeoutMs: 120_000,
        })
        suspendReasons.set(suspendNodeId, node.reason)
        appendSequential(suspendNodeId, nextNodeIdInFlow)
        nextNodeIdInFlow = suspendNodeId
        break
      }

      case 'branch': {
        const { nodeId, predicateName } = addBranchNode(node.condition, node.branches)

        const branchTargets: Record<string, string> = {}
        for (const [branchName, branchSteps] of Object.entries(node.branches)) {
          const targetId = compileStepSequence(branchSteps, nextNodeIdInFlow, `branch:${branchName}`)
          if (targetId) {
            branchTargets[branchName] = targetId
          }
        }

        if (Object.keys(branchTargets).length === 0) {
          // Branch node with no executable targets — create a passthrough noop.
          const passthroughId = addTransformNode('noop', async () => ({}), 'branch-passthrough')
          appendSequential(passthroughId, nextNodeIdInFlow)
          branchTargets['__default__'] = passthroughId
          predicates[predicateName] = () => '__default__'
        }

        edges.push({
          type: 'conditional',
          sourceNodeId: nodeId,
          predicateName,
          branches: branchTargets,
        })
        nextNodeIdInFlow = nodeId
        break
      }
    }
  }

  if (!nextNodeIdInFlow) {
    nextNodeIdInFlow = addTransformNode('noop', async () => ({}), 'empty-workflow')
  }

  const definition: PipelineDefinition = {
    id: config.id,
    name: config.id,
    version: '1.0.0',
    description: config.description,
    schemaVersion: '1.0.0',
    entryNodeId: nextNodeIdInFlow,
    nodes: pipelineNodes,
    edges,
    checkpointStrategy: 'none',
    metadata: {
      source: 'WorkflowBuilder',
      runtime: 'PipelineRuntime',
    },
    tags: ['workflow-compat'],
  }

  return {
    definition,
    predicates,
    suspendReasons,
    createNodeExecutor: (emit, onStateObserved) => {
      const executor: NodeExecutor = async (
        nodeId: string,
        node: PipelineNode,
        context: NodeExecutionContext,
      ) => {
        onStateObserved(context.state)

        if (node.type !== 'transform') {
          return {
            nodeId,
            output: null,
            durationMs: 0,
          }
        }

        const handler = handlers.get(node.transformName)
        if (!handler) {
          return {
            nodeId,
            output: null,
            durationMs: 0,
            error: `No workflow transform handler found for "${node.transformName}"`,
          }
        }

        const startedAt = Date.now()
        try {
          const workflowCtx: WorkflowContext = {
            workflowId: config.id,
            state: context.state,
            signal: context.signal,
          }
          const output = await handler(context.state, workflowCtx, emit)
          onStateObserved(context.state)
          return {
            nodeId,
            output: output ?? null,
            durationMs: Date.now() - startedAt,
          }
        } catch (err) {
          return {
            nodeId,
            output: null,
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }

      return executor
    },
  }
}

/** Factory function for creating workflows */
export function createWorkflow(config: WorkflowConfig): WorkflowBuilder {
  return new WorkflowBuilder(config)
}
