/**
 * Adapter Workflow Builder -- Declarative workflow DSL for multi-step
 * adapter orchestrations with provider-per-step routing.
 *
 * Supports sequential steps, parallel fan-out, conditional branching,
 * state transforms, per-step retries, and preferred-provider routing.
 *
 * Ownership model:
 * - `@dzupagent/flow-compiler` owns FlowDocument/FlowNode parsing,
 *   semantic resolution, target routing, and graph lowering for authored
 *   flows.
 * - `AdapterWorkflowBuilder` owns the provider-oriented compatibility DSL in
 *   this package. It does not import the flow compiler; its shared contract is
 *   the `@dzupagent/core` `PipelineDefinition` executed by `PipelineRuntime`.
 * - Equivalence is guaranteed only at that pipeline contract boundary: step
 *   order is represented by sequential edges, and branch choices are
 *   represented by conditional edges whose targets are compiled step nodes.
 * - Parallel merge, loop iteration, adapter routing, retries, prompt
 *   templating, and workflow events are intentionally adapter-owned runtime
 *   semantics. Flow compiler parallel/loop/event semantics are not treated as
 *   equivalent unless a future migration routes this builder through the
 *   compiler explicitly.
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

import { ForgeError } from '@dzupagent/core/events'
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core/pipeline'
import type { PipelineRuntimeEvent } from '@dzupagent/runtime-contracts'
import type {
  PipelineExecutorFactory,
  PipelineExecutorPort,
} from '@dzupagent/adapter-types'

import { defaultPipelineExecutorFactory } from './default-pipeline-executor.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { WorkflowValidator } from './workflow-validator.js'
import { sharedTemplateResolver } from './adapter-workflow-execution.js'
import type {
  AdapterStepConfig,
  AdapterStepResult,
  AdapterWorkflowConfig,
  AdapterWorkflowEvent,
  AdapterWorkflowResult,
  AdapterWorkflowRunOptions,
  BranchCondition,
  LoopConfig,
  ParallelMergeStrategy,
} from './adapter-workflow-types.js'
import {
  assemblePipeline,
  type AdapterWorkflowNode,
  type PipelineAssemblyResult,
} from './pipeline-assembler.js'
export { ADAPTER_WORKFLOW_OWNERSHIP } from './workflow-ownership.js'
export type {
  AdapterStepConfig,
  AdapterStepResult,
  AdapterWorkflowConfig,
  AdapterWorkflowEvent,
  AdapterWorkflowResult,
  AdapterWorkflowRunOptions,
  BranchCondition,
  LoopConfig,
  ParallelMergeStrategy,
} from './adapter-workflow-types.js'

// ---------------------------------------------------------------------------
// AdapterWorkflow (executable)
// ---------------------------------------------------------------------------

/**
 * Executable adapter workflow.
 *
 * Created by `AdapterWorkflowBuilder.build()`. Runs nodes sequentially,
 * delegating adapter calls to the registry with automatic fallback.
 */
export class AdapterWorkflow {
  private readonly compilation: PipelineAssemblyResult
  private readonly executorFactory: PipelineExecutorFactory<PipelineDefinition, PipelineNode>

  constructor(
    private readonly workflowConfig: AdapterWorkflowConfig,
    nodes: AdapterWorkflowNode[],
    executorFactory: PipelineExecutorFactory<PipelineDefinition, PipelineNode> = defaultPipelineExecutorFactory,
  ) {
    this.compilation = assemblePipeline(workflowConfig, nodes)
    this.executorFactory = executorFactory
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
    registry: ProviderAdapterRegistry,
    options?: AdapterWorkflowRunOptions,
  ): Promise<AdapterWorkflowResult> {
    const state: Record<string, unknown> = { ...(options?.initialState ?? {}) }
    let latestObservedState: Record<string, unknown> = state
    const stepResults: AdapterStepResult[] = []
    const emit = options?.onEvent ?? (() => {})
    const overallStart = Date.now()
    let failureEventEmitted = false

    emit({ type: 'workflow:started', workflowId: this.workflowConfig.id, ...(this.workflowConfig.version !== undefined ? { version: this.workflowConfig.version } : {}) })

    if (options?.signal?.aborted) {
      return {
        workflowId: this.workflowConfig.id,
        success: false,
        finalState: this.publicStateFrom(latestObservedState),
        stepResults,
        totalDurationMs: Date.now() - overallStart,
        cancelled: true,
        version: this.workflowConfig.version,
      }
    }

    try {
      const executor: PipelineExecutorPort = this.executorFactory({
        definition: this.compilation.definition,
        nodeExecutor: this.compilation.createNodeExecutor(registry, emit, stepResults, (observed) => {
          latestObservedState = observed
        }),
        // Runtime accepts branch keys as strings, but config type narrows to boolean.
        predicates: this.compilation.predicates as Record<string, (state: Record<string, unknown>) => boolean>,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        onEvent: (event) => this.handleRuntimeEvent(event as PipelineRuntimeEvent, emit, () => {
          failureEventEmitted = true
        }),
      })

      const runtimeResult = await executor.execute(state)
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
        version: this.workflowConfig.version,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
        return {
          workflowId: this.workflowConfig.id,
          success: false,
          finalState: this.publicStateFrom(latestObservedState),
          stepResults,
          totalDurationMs: Date.now() - overallStart,
          cancelled: true,
          version: this.workflowConfig.version,
        }
      }
      if (!failureEventEmitted) {
        emit({ type: 'workflow:failed', workflowId: this.workflowConfig.id, error: message })
      }

      return {
        workflowId: this.workflowConfig.id,
        success: false,
        finalState: this.publicStateFrom(latestObservedState),
        stepResults,
        totalDurationMs: Date.now() - overallStart,
        version: this.workflowConfig.version,
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
          ...(this.workflowConfig.version !== undefined ? { version: this.workflowConfig.version } : {}),
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
  private executorFactory: PipelineExecutorFactory<PipelineDefinition, PipelineNode> | undefined

  constructor(private readonly config: AdapterWorkflowConfig) {}

  /**
   * Inject a custom `PipelineExecutorFactory` for the resulting workflow.
   *
   * When unset, `build()` uses `defaultPipelineExecutorFactory`, which
   * binds the canonical `PipelineRuntime` from `@dzupagent/agent`. Tests
   * and alternative runtimes can supply their own factory here without
   * `AdapterWorkflowBuilder` needing to know about the concrete class.
   */
  withExecutorFactory(factory: PipelineExecutorFactory<PipelineDefinition, PipelineNode>): this {
    this.executorFactory = factory
    return this
  }

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

  /** Add a loop construct that re-executes steps while a condition holds. */
  loop(config: LoopConfig): this {
    this.nodes.push({ type: 'loop', config })
    return this
  }

  /** Build into an executable workflow. */
  build(): AdapterWorkflow {
    const validator = new WorkflowValidator(sharedTemplateResolver)
    const result = validator.validate(this.nodes)
    if (result.errors.length > 0) {
      throw new ForgeError({
        code: 'VALIDATION_FAILED',
        message: `Workflow has validation errors:\n${result.errors.map((e) => `  ${e.stepId}: ${e.message}`).join('\n')}`,
      })
    }
    return new AdapterWorkflow(
      this.config,
      [...this.nodes],
      this.executorFactory ?? defaultPipelineExecutorFactory,
    )
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/** Create a new adapter workflow builder with a fluent API. */
export function defineWorkflow(config: AdapterWorkflowConfig): AdapterWorkflowBuilder {
  return new AdapterWorkflowBuilder({
    ...config,
    version: config.version ?? '1.0.0',
  })
}

/**
 * Create a step config with a typed prompt function.
 * Provides type-safe state access via function instead of template strings.
 *
 * @example
 * ```typescript
 * interface MyState { research: string; plan: string }
 *
 * defineWorkflow({ id: 'pipeline' })
 *   .step(typedStep<MyState>({
 *     id: 'plan',
 *     promptFn: (state) => `Create plan from: ${state.research}`,
 *     tags: ['planning'],
 *   }))
 *   .build()
 * ```
 */
export function typedStep<TState extends Record<string, unknown> = Record<string, unknown>>(
  config: Omit<AdapterStepConfig, 'promptFn'> & {
    promptFn: (state: TState) => string
  },
): AdapterStepConfig {
  return {
    ...config,
    promptFn: config.promptFn as (state: Record<string, unknown>) => string,
  }
}
