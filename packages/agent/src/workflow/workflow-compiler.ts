/**
 * Internal workflow compiler — translates `WorkflowNode[]` into a canonical
 * `PipelineDefinition` that can be executed by `PipelineRuntime`.
 *
 * Exported for use by `CompiledWorkflow`; not part of the public package surface.
 */
import type {
  PipelineDefinition,
  PipelineNode,
} from '@dzupagent/core'
import type {
  WorkflowStep,
  WorkflowNode,
  MergeStrategy,
  WorkflowContext,
  WorkflowEvent,
} from './workflow-types.js'
import type { WorkflowConfig, WorkflowErrorHandler } from './workflow-builder-types.js'
import type { NodeExecutor, NodeExecutionContext } from '../pipeline/pipeline-runtime-types.js'
import { omitUndefined } from '../utils/exact-optional.js'

// ---------------------------------------------------------------------------
// WorkflowCompilation — internal return type from compileWorkflow()
// ---------------------------------------------------------------------------

export interface WorkflowCompilation {
  definition: PipelineDefinition
  predicates: Record<string, (state: Record<string, unknown>) => boolean | string>
  suspendReasons: Map<string, string>
  createNodeExecutor: (
    emit: (event: WorkflowEvent) => void,
    onStateObserved: (state: Record<string, unknown>) => void,
  ) => NodeExecutor
}

// ---------------------------------------------------------------------------
// applyErrorHandlers
// ---------------------------------------------------------------------------

/**
 * Try each registered error handler against `err`; the first matching handler
 * wins. Recovery steps are executed in sequence with `state.error` populated
 * (a serializable view of the original error) and any object outputs are
 * merged back into the workflow state. Returns `true` when an handler ran
 * successfully; otherwise the caller must re-throw.
 */
export async function applyErrorHandlers(
  err: unknown,
  state: Record<string, unknown>,
  ctx: WorkflowContext,
  emit: (event: WorkflowEvent) => void,
  errorHandlers: WorkflowErrorHandler[],
): Promise<boolean> {
  if (errorHandlers.length === 0) return false
  const errorObj = err instanceof Error ? err : new Error(String(err))
  const matching = errorHandlers.find(h => {
    try {
      return h.predicate(errorObj)
    } catch {
      return false
    }
  })
  if (!matching) return false

  const errorView = {
    name: errorObj.name,
    message: errorObj.message,
    stack: errorObj.stack,
  }
  state['error'] = errorView

  for (const recoveryStep of matching.recoverySteps) {
    const start = Date.now()
    emit({ type: 'step:started', stepId: recoveryStep.id })
    try {
      const result = await recoveryStep.execute(state, ctx) as
        | Record<string, unknown>
        | undefined
      if (result && typeof result === 'object') {
        Object.assign(state, result)
      }
      emit({ type: 'step:completed', stepId: recoveryStep.id, durationMs: Date.now() - start })
    } catch (recoveryErr) {
      const message = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
      emit({ type: 'step:failed', stepId: recoveryStep.id, error: message })
      throw recoveryErr
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// compileWorkflow
// ---------------------------------------------------------------------------

export function compileWorkflow(
  config: WorkflowConfig,
  nodes: WorkflowNode[],
  errorHandlers: WorkflowErrorHandler[] = [],
): WorkflowCompilation {
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
    pipelineNodes.push(omitUndefined({
      id: nodeId,
      type: 'transform',
      transformName,
      name,
      timeoutMs: 120_000,
    }))
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
          // Try to recover via a registered error handler. If a handler runs
          // successfully, we treat the step as recovered and continue the
          // workflow; otherwise re-throw so the runtime fails the node.
          const recovered = await applyErrorHandlers(err, state, ctx, emit, errorHandlers)
          if (recovered) {
            return undefined
          }
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
              // Per-branch recovery -- if a handler claims this error, treat
              // the parallel branch as recovered with an empty contribution.
              const recovered = await applyErrorHandlers(err, state, ctx, emit, errorHandlers)
              if (recovered) {
                return {}
              }
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

  const definition: PipelineDefinition = omitUndefined({
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
  })

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
          const workflowCtx: WorkflowContext = omitUndefined({
            workflowId: config.id,
            state: context.state,
            signal: context.signal,
          })
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
