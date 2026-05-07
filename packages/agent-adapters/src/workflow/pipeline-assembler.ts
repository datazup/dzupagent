/**
 * Pipeline assembler -- lowers an `AdapterWorkflowBuilder` node list into a
 * canonical `PipelineDefinition` plus the runtime predicates and node-executor
 * factory required to drive `PipelineRuntime`.
 *
 * Extracted from `adapter-workflow.ts` so the builder stays focused on the
 * fluent DSL surface and the assembler can be exercised directly by tests.
 */

import type { PipelineDefinition, PipelineNode } from '@dzupagent/core'
import type {
  NodeExecutionContext,
  NodeExecutor,
  NodeResult,
} from '@dzupagent/agent/pipeline'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterStepConfig,
  AdapterStepResult,
  AdapterWorkflowConfig,
  AdapterWorkflowEvent,
  BranchCondition,
  ParallelMergeStrategy,
  LoopConfig,
} from './adapter-workflow-types.js'
import { ADAPTER_WORKFLOW_OWNERSHIP } from './workflow-ownership.js'
import {
  PREV_RESULT_STATE_KEY,
  executeAdapterStep,
  executeLoop,
  mergeParallelResults,
  resolveFallbackProviderId,
} from './adapter-workflow-execution.js'

/**
 * Internal node representation produced by the fluent builder before
 * lowering into a `PipelineDefinition`. Exported so the builder file can
 * accumulate them and hand them to `assemblePipeline()`.
 */
export type AdapterWorkflowNode =
  | { type: 'step'; config: AdapterStepConfig }
  | { type: 'parallel'; steps: AdapterStepConfig[]; mergeStrategy: ParallelMergeStrategy }
  | { type: 'branch'; condition: BranchCondition; branches: Record<string, AdapterStepConfig[]> }
  | { type: 'transform'; id: string; fn: (state: Record<string, unknown>) => Record<string, unknown> }
  | { type: 'loop'; config: LoopConfig }

/**
 * Result of lowering an adapter workflow into its canonical pipeline form.
 *
 * - `definition` is the `PipelineDefinition` consumed by `PipelineRuntime`.
 * - `predicates` resolves conditional-edge labels back to runtime branch keys.
 * - `internalStateKeys` lists keys that must be stripped from the public state
 *   before returning to the caller.
 * - `createNodeExecutor` produces the per-run `NodeExecutor` bound to the
 *   given registry, emit callback, and step-result accumulator.
 */
export interface PipelineAssemblyResult {
  definition: PipelineDefinition
  predicates: Record<string, (state: Record<string, unknown>) => boolean | string>
  internalStateKeys: Set<string>
  createNodeExecutor: (
    registry: ProviderAdapterRegistry,
    emit: (event: AdapterWorkflowEvent) => void,
    stepResults: AdapterStepResult[],
    onStateObserved: (state: Record<string, unknown>) => void,
  ) => NodeExecutor
}

/**
 * Lower a list of `AdapterWorkflowNode`s into a `PipelineAssemblyResult`.
 *
 * The function walks the node list in reverse so each node can wire its
 * sequential edge to the already-assembled successor. Branch nodes emit a
 * conditional edge whose targets are the per-branch step sequences. The
 * resulting `createNodeExecutor` reads the per-node handler closure stored
 * during assembly and invokes it inside `PipelineRuntime`'s execution loop.
 */
export function assemblePipeline(
  config: AdapterWorkflowConfig,
  nodes: ReadonlyArray<AdapterWorkflowNode>,
): PipelineAssemblyResult {
  const pipelineNodes: PipelineNode[] = []
  const edges: PipelineDefinition['edges'] = []
  const predicates: Record<string, (state: Record<string, unknown>) => boolean | string> = {}
  const handlers = new Map<string, (
    registry: ProviderAdapterRegistry,
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
      registry: ProviderAdapterRegistry,
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
            providerId: resolveFallbackProviderId(registry, step.preferredProvider),
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
      case 'loop': {
        const loopNodeId = addTransformNode(
          'loop',
          async (registry, state, signal, emit, stepResults) => {
            const result = await executeLoop(
              node.config,
              config.id,
              registry,
              state,
              emit,
              stepResults,
              signal,
            )
            Object.assign(state, result)
            return { loopId: node.config.id, completed: true }
          },
          `loop:${node.config.id}`,
        )
        appendSequential(loopNodeId, nextNodeIdInFlow)
        nextNodeIdInFlow = loopNodeId
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
    version: config.version ?? '1.0.0',
    schemaVersion: '1.0.0',
    ...(config.description !== undefined ? { description: config.description } : {}),
    entryNodeId: nextNodeIdInFlow,
    nodes: pipelineNodes,
    edges,
    checkpointStrategy: 'none',
    metadata: {
      source: 'AdapterWorkflowBuilder',
      runtime: 'PipelineRuntime',
      workflowOwnership: ADAPTER_WORKFLOW_OWNERSHIP.owner,
      canonicalContract: ADAPTER_WORKFLOW_OWNERSHIP.canonicalContract,
      flowCompilerDependency: ADAPTER_WORKFLOW_OWNERSHIP.flowCompilerDependency,
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
