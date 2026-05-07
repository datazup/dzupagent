/**
 * Per-node builders used by the workflow compiler.
 *
 * Each builder ("step", "parallel", "branch", "transform") allocates a
 * pipeline node id, registers its handler with the shared transform map,
 * and pushes the node descriptor onto the compilation's `pipelineNodes`
 * array. Extracted from `workflow-compiler.ts` so the compiler coordinator
 * stays focused on flow lowering.
 *
 * @module workflow/workflow-compiler-node-builders
 */
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core/pipeline'
import type {
  WorkflowStep,
  MergeStrategy,
} from './workflow-types.js'
import type { WorkflowConfig, WorkflowErrorHandler } from './workflow-builder-types.js'
import type { WorkflowTransformHandler } from './workflow-compiler-types.js'
import { applyErrorHandlers } from './workflow-compiler-error-handlers.js'
import { omitUndefined } from '../utils/exact-optional.js'

/**
 * Mutable compilation context shared between the builders. Owned by the
 * compiler coordinator and threaded into `createNodeBuilders` so each
 * builder can register handlers, append nodes/edges, and bump shared
 * sequence counters without exposing them on the public surface.
 */
export interface NodeBuilderContext {
  config: WorkflowConfig
  errorHandlers: WorkflowErrorHandler[]
  pipelineNodes: PipelineNode[]
  edges: PipelineDefinition['edges']
  predicates: Record<string, (state: Record<string, unknown>) => boolean | string>
  handlers: Map<string, WorkflowTransformHandler>
  /** Monotonic counter used by `nextNodeId`/branch selection keys. */
  nodeSeqRef: { value: number }
  transformSeqRef: { value: number }
  predicateSeqRef: { value: number }
}

export interface NodeBuilders {
  nextNodeId: (prefix: string) => string
  appendSequential: (sourceNodeId: string, targetNodeId: string | undefined) => void
  addTransformNode: (
    prefix: string,
    handler: WorkflowTransformHandler,
    name?: string,
  ) => string
  addStepNode: (step: WorkflowStep, labelPrefix: string) => string
  addParallelNode: (steps: WorkflowStep[], mergeStrategy: MergeStrategy) => string
  addBranchNode: (
    condition: (state: Record<string, unknown>) => string,
    branches: Record<string, WorkflowStep[]>,
  ) => { nodeId: string; predicateName: string }
}

/**
 * Apply a parallel-step merge strategy to the shared workflow state.
 * Exported so the compiler coordinator can keep the pure helper unit
 * testable; called only from `addParallelNode` in production paths.
 */
export function mergeResults(
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

export function createNodeBuilders(ctx: NodeBuilderContext): NodeBuilders {
  const {
    config,
    errorHandlers,
    pipelineNodes,
    edges,
    predicates,
    handlers,
    nodeSeqRef,
    transformSeqRef,
    predicateSeqRef,
  } = ctx

  const nextNodeId = (prefix: string): string => `${prefix}_${nodeSeqRef.value++}`
  const nextTransformName = (prefix: string): string => `wf_${prefix}_${transformSeqRef.value++}`
  const nextPredicateName = (): string => `wf_predicate_${predicateSeqRef.value++}`

  const addTransformNode = (
    prefix: string,
    handler: WorkflowTransformHandler,
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

  const addStepNode = (step: WorkflowStep, labelPrefix: string): string => {
    return addTransformNode(
      'step',
      async (state, stepCtx, emit) => {
        const start = Date.now()
        emit({ type: 'step:started', stepId: step.id })
        try {
          const result = await step.execute(state, stepCtx) as Record<string, unknown> | undefined
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
          const recovered = await applyErrorHandlers(err, state, stepCtx, emit, errorHandlers)
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
      async (state, parallelCtx, emit) => {
        const stepIds = steps.map(s => s.id)
        const start = Date.now()
        emit({ type: 'parallel:started', stepIds })

        const results = await Promise.all(
          steps.map(async (step) => {
            emit({ type: 'step:started', stepId: step.id })
            const stepStart = Date.now()
            try {
              const result = await step.execute(state, parallelCtx) as Record<string, unknown> | undefined
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
              const recovered = await applyErrorHandlers(err, state, parallelCtx, emit, errorHandlers)
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
    const selectionKey = `__wf_branch_selection_${nodeSeqRef.value}`
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

  return {
    nextNodeId,
    appendSequential,
    addTransformNode,
    addStepNode,
    addParallelNode,
    addBranchNode,
  }
}
