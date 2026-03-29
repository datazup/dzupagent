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

import type { DzipEventBus, PipelineDefinition, PipelineNode } from '@dzipagent/core'
import { PipelineRuntime } from '@dzipagent/agent'
import type {
  NodeExecutionContext,
  NodeExecutor,
  NodeResult,
  PipelineRuntimeEvent,
} from '@dzipagent/agent'

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

interface AdapterWorkflowCompilation {
  definition: PipelineDefinition
  predicates: Record<string, (state: Record<string, unknown>) => boolean | string>
  internalStateKeys: Set<string>
  createNodeExecutor: (
    registry: AdapterRegistry,
    emit: (event: AdapterWorkflowEvent) => void,
    stepResults: AdapterStepResult[],
    onStateObserved: (state: Record<string, unknown>) => void,
  ) => NodeExecutor
}

const PREV_RESULT_STATE_KEY = '__adapter_workflow_internal_prev_result'

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
  private readonly compilation: AdapterWorkflowCompilation

  constructor(
    private readonly workflowConfig: AdapterWorkflowConfig,
    nodes: AdapterWorkflowNode[],
  ) {
    this.compilation = compileAdapterWorkflow(workflowConfig, nodes)
  }

  /** The workflow identifier. */
  get id(): string {
    return this.workflowConfig.id
  }

  /** Inspect the compiled canonical pipeline definition. */
  toPipelineDefinition(): PipelineDefinition {
    return structuredClone(this.compilation.definition)
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
    let latestObservedState: Record<string, unknown> = state
    const stepResults: AdapterStepResult[] = []
    const emit = options?.onEvent ?? (() => {})
    const overallStart = Date.now()
    let failureEventEmitted = false

    emit({ type: 'workflow:started', workflowId: this.workflowConfig.id })

    try {
      const runtime = new PipelineRuntime({
        definition: this.compilation.definition,
        nodeExecutor: this.compilation.createNodeExecutor(registry, emit, stepResults, (observed) => {
          latestObservedState = observed
        }),
        // Runtime accepts branch keys as strings, but config type narrows to boolean.
        predicates: this.compilation.predicates as Record<string, (state: Record<string, unknown>) => boolean>,
        signal: options?.signal,
        onEvent: (event) => this.handleRuntimeEvent(event, emit, () => {
          failureEventEmitted = true
        }),
      })

      const runtimeResult = await runtime.execute(state)
      if (runtimeResult.state !== 'completed') {
        throw new Error(this.extractFailure(runtimeResult.nodeResults) ?? 'Workflow execution failed')
      }

      const totalDurationMs = Date.now() - overallStart

      return {
        workflowId: this.workflowConfig.id,
        success: true,
        finalState: this.publicStateFrom(latestObservedState),
        stepResults,
        totalDurationMs,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!failureEventEmitted) {
        emit({ type: 'workflow:failed', workflowId: this.workflowConfig.id, error: message })
      }

      return {
        workflowId: this.workflowConfig.id,
        success: false,
        finalState: this.publicStateFrom(latestObservedState),
        stepResults,
        totalDurationMs: Date.now() - overallStart,
      }
    }
  }

  private handleRuntimeEvent(
    event: PipelineRuntimeEvent,
    emit: (event: AdapterWorkflowEvent) => void,
    onFailureEmitted: () => void,
  ): void {
    switch (event.type) {
      case 'pipeline:completed':
        emit({
          type: 'workflow:completed',
          workflowId: this.workflowConfig.id,
          durationMs: event.totalDurationMs,
        })
        break
      case 'pipeline:failed':
        onFailureEmitted()
        emit({
          type: 'workflow:failed',
          workflowId: this.workflowConfig.id,
          error: event.error,
        })
        break
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

  private publicStateFrom(state: Record<string, unknown>): Record<string, unknown> {
    const publicState = { ...state }
    for (const key of this.compilation.internalStateKeys) {
      delete publicState[key]
    }
    return publicState
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

function compileAdapterWorkflow(
  config: AdapterWorkflowConfig,
  nodes: AdapterWorkflowNode[],
): AdapterWorkflowCompilation {
  const pipelineNodes: PipelineNode[] = []
  const edges: PipelineDefinition['edges'] = []
  const predicates: Record<string, (state: Record<string, unknown>) => boolean | string> = {}
  const handlers = new Map<string, (
    registry: AdapterRegistry,
    state: Record<string, unknown>,
    signal: AbortSignal | undefined,
    emit: (event: AdapterWorkflowEvent) => void,
    stepResults: AdapterStepResult[],
  ) => Promise<unknown>>()
  const internalStateKeys = new Set<string>([PREV_RESULT_STATE_KEY])

  let nodeSeq = 0
  let transformSeq = 0
  let predicateSeq = 0

  const nextNodeId = (prefix: string): string => `${prefix}_${nodeSeq++}`
  const nextTransformName = (prefix: string): string => `adapter_wf_${prefix}_${transformSeq++}`
  const nextPredicateName = (): string => `adapter_wf_predicate_${predicateSeq++}`

  const addTransformNode = (
    prefix: string,
    handler: (
      registry: AdapterRegistry,
      state: Record<string, unknown>,
      signal: AbortSignal | undefined,
      emit: (event: AdapterWorkflowEvent) => void,
      stepResults: AdapterStepResult[],
    ) => Promise<unknown>,
    name: string,
    timeoutMs = 120_000,
  ): string => {
    const nodeId = nextNodeId(prefix)
    const transformName = nextTransformName(prefix)
    handlers.set(transformName, handler)
    pipelineNodes.push({
      id: nodeId,
      type: 'transform',
      transformName,
      name,
      timeoutMs,
    })
    return nodeId
  }

  const appendSequential = (sourceNodeId: string, targetNodeId: string | undefined): void => {
    if (!targetNodeId) return
    edges.push({ type: 'sequential', sourceNodeId, targetNodeId })
  }

  const addStepNode = (step: AdapterStepConfig, labelPrefix: string): string => {
    return addTransformNode(
      'step',
      async (registry, state, signal, emit, stepResults) => {
        const prevResult = typeof state[PREV_RESULT_STATE_KEY] === 'string'
          ? (state[PREV_RESULT_STATE_KEY] as string)
          : undefined
        const result = await executeAdapterStep(
          registry,
          config.id,
          step,
          state,
          prevResult,
          emit,
          signal,
        )
        stepResults.push(result)
        state[step.id] = result.result
        if (result.success) {
          state[PREV_RESULT_STATE_KEY] = result.result
        }
        if (!result.success) {
          throw new Error(`Step "${step.id}" failed: ${result.error ?? 'unknown error'}`)
        }
        return { stepId: step.id, success: true }
      },
      `${labelPrefix}:${step.id}`,
    )
  }

  const addParallelNode = (
    steps: AdapterStepConfig[],
    mergeStrategy: ParallelMergeStrategy,
  ): string => {
    return addTransformNode(
      'parallel',
      async (registry, state, signal, emit, stepResults) => {
        const prevResult = typeof state[PREV_RESULT_STATE_KEY] === 'string'
          ? (state[PREV_RESULT_STATE_KEY] as string)
          : undefined
        const snapshot = { ...state }
        const stepIds = steps.map((s) => s.id)
        emit({ type: 'parallel:started', workflowId: config.id, stepIds })
        const parallelStart = Date.now()

        const settled = await Promise.allSettled(
          steps.map((stepConfig) =>
            executeAdapterStep(registry, config.id, stepConfig, snapshot, prevResult, emit, signal),
          ),
        )

        const results: AdapterStepResult[] = settled.map((outcome, idx) => {
          const step = steps[idx] as AdapterStepConfig
          if (outcome.status === 'fulfilled') {
            return outcome.value
          }
          const errorMessage =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
          return {
            stepId: step.id,
            result: '',
            providerId: step.preferredProvider ?? 'claude',
            success: false,
            durationMs: 0,
            retries: 0,
            error: errorMessage,
          }
        })

        stepResults.push(...results)
        mergeParallelResults(state, results, mergeStrategy)
        state[PREV_RESULT_STATE_KEY] = results
          .filter((r) => r.success)
          .map((r) => r.result)
          .join('\n\n')

        emit({
          type: 'parallel:completed',
          workflowId: config.id,
          stepIds,
          durationMs: Date.now() - parallelStart,
        })

        return { parallelResults: results.length }
      },
      'parallel',
    )
  }

  const addBranchSelectorNode = (
    condition: BranchCondition,
    branches: Record<string, AdapterStepConfig[]>,
  ): { nodeId: string; predicateName: string; selectionKey: string } => {
    const selectionKey = `__adapter_workflow_internal_branch_selection_${nodeSeq}`
    internalStateKeys.add(selectionKey)
    const predicateName = nextPredicateName()

    predicates[predicateName] = (state) => {
      const selected = state[selectionKey]
      return typeof selected === 'string' ? selected : ''
    }

    const nodeId = addTransformNode(
      'branch',
      async (_registry, state, _signal, emit) => {
        const selected = condition(state)
        emit({ type: 'branch:evaluated', workflowId: config.id, selected })
        if (!Object.prototype.hasOwnProperty.call(branches, selected)) {
          throw new Error(
            `Branch "${selected}" not found in workflow "${config.id}". ` +
              `Available branches: ${Object.keys(branches).join(', ')}`,
          )
        }
        state[selectionKey] = selected
        return { [selectionKey]: selected }
      },
      'branch',
    )

    return { nodeId, predicateName, selectionKey }
  }

  const compileStepSequence = (
    steps: AdapterStepConfig[],
    continuationNodeId: string | undefined,
    sequenceLabel: string,
  ): string | undefined => {
    if (steps.length === 0) return continuationNodeId

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
        const stepNodeId = addStepNode(node.config, 'linear')
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
      case 'transform': {
        const transformNodeId = addTransformNode(
          'transform',
          async (_registry, state) => {
            const transformed = node.fn(state)
            Object.assign(state, transformed)
            return transformed
          },
          `transform:${node.id}`,
        )
        appendSequential(transformNodeId, nextNodeIdInFlow)
        nextNodeIdInFlow = transformNodeId
        break
      }
      case 'branch': {
        const { nodeId, predicateName } = addBranchSelectorNode(node.condition, node.branches)
        const branchTargets: Record<string, string> = {}
        for (const [branchName, branchSteps] of Object.entries(node.branches)) {
          const targetId = compileStepSequence(branchSteps, nextNodeIdInFlow, `branch:${branchName}`)
          if (targetId) {
            branchTargets[branchName] = targetId
          }
        }
        if (Object.keys(branchTargets).length === 0 && nextNodeIdInFlow) {
          branchTargets['__default__'] = nextNodeIdInFlow
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
    schemaVersion: '1.0.0',
    description: config.description,
    entryNodeId: nextNodeIdInFlow,
    nodes: pipelineNodes,
    edges,
    checkpointStrategy: 'none',
    metadata: {
      source: 'AdapterWorkflowBuilder',
      runtime: 'PipelineRuntime',
    },
    tags: ['adapter-workflow-compat'],
  }

  return {
    definition,
    predicates,
    internalStateKeys,
    createNodeExecutor: (registry, emit, stepResults, onStateObserved) => {
      const nodeExecutor: NodeExecutor = async (
        nodeId: string,
        node: PipelineNode,
        context: NodeExecutionContext,
      ): Promise<NodeResult> => {
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
            error: `No adapter workflow handler found for "${node.transformName}"`,
          }
        }

        const startedAt = Date.now()
        try {
          const output = await handler(
            registry,
            context.state,
            context.signal,
            emit,
            stepResults,
          )
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

      return nodeExecutor
    },
  }
}

async function executeAdapterStep(
  registry: AdapterRegistry,
  workflowId: string,
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
    if (signal?.aborted) {
      throw new Error('Workflow execution was aborted')
    }

    if (attempt > 0) {
      emit({
        type: 'step:retrying',
        workflowId,
        stepId: config.id,
        attempt,
        maxRetries,
      })
    }

    emit({ type: 'step:started', workflowId, stepId: config.id })
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

      const { resultText, providerId } = await consumeAdapterEvents(registry, input, task, signal)
      const durationMs = Date.now() - stepStart

      emit({
        type: 'step:completed',
        workflowId,
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
        workflowId,
        stepId: config.id,
        error: errorMessage,
        retryCount: attempt,
      })

      if (attempt < maxRetries) {
        attempt++
        continue
      }

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

function mergeParallelResults(
  state: Record<string, unknown>,
  results: AdapterStepResult[],
  strategy: ParallelMergeStrategy,
): void {
  switch (strategy) {
    case 'merge': {
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
    case 'concat': {
      state['parallelResults'] = results.map((r) => ({
        stepId: r.stepId,
        result: r.result,
        success: r.success,
      }))
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
    case 'last-wins': {
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

async function consumeAdapterEvents(
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
    if (signal?.aborted) {
      throw new Error('Workflow execution was aborted')
    }

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
