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

import { ForgeError } from '@dzupagent/core'
import type { DzupEventBus, PipelineDefinition, PipelineNode } from '@dzupagent/core'
import type { PipelineRuntimeEvent } from '@dzupagent/agent'
import type {
  PipelineExecutorFactory,
  PipelineExecutorPort,
} from '@dzupagent/adapter-types'

import { defaultPipelineExecutorFactory } from './default-pipeline-executor.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { AdapterProviderId } from '../types.js'
import { WorkflowValidator } from './workflow-validator.js'
import { sharedTemplateResolver } from './adapter-workflow-execution.js'
import {
  assemblePipeline,
  type AdapterWorkflowNode,
  type PipelineAssemblyResult,
} from './pipeline-assembler.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the adapter workflow. */
export interface AdapterWorkflowConfig {
  id: string
  /** Semantic version of this workflow definition. Default: '1.0.0' */
  version?: string | undefined
  /** Human-readable description */
  description?: string | undefined
}

/** Configuration for a single workflow step. */
export interface AdapterStepConfig {
  /** Step identifier */
  id: string
  /** Prompt template. Can use {{prev}} for previous step result and {{state.key}} for state access */
  prompt: string
  /** Tags for routing */
  tags?: string[] | undefined
  /** Preferred provider for this step */
  preferredProvider?: AdapterProviderId | undefined
  /** Whether this step requires reasoning */
  requiresReasoning?: boolean | undefined
  /** Whether this step requires execution */
  requiresExecution?: boolean | undefined
  /** Max retries on failure. Default 0 */
  maxRetries?: number | undefined
  /** System prompt override for this step */
  systemPrompt?: string | undefined
  /** Working directory override */
  workingDirectory?: string | undefined
  /** Max turns for the adapter */
  maxTurns?: number | undefined
  /** Per-step timeout in ms. Independent of adapter timeout. */
  timeoutMs?: number | undefined
  /** Skip this step if condition returns true */
  skipIf?: (state: Record<string, unknown>) => boolean
  /** Default value when step is skipped */
  skipDefault?: string | undefined
  /**
   * Function-based prompt for type-safe state access.
   * Takes precedence over `prompt` string if both provided.
   */
  promptFn?: (state: Record<string, unknown>) => string
}

/** Result of the entire workflow. */
export interface AdapterWorkflowResult {
  workflowId: string
  success: boolean
  finalState: Record<string, unknown>
  stepResults: AdapterStepResult[]
  totalDurationMs: number
  cancelled?: true | undefined
  /** Semantic version of the workflow definition that produced this result */
  version?: string | undefined
}

/** Result of a single step. */
export interface AdapterStepResult {
  stepId: string
  result: string
  providerId: AdapterProviderId
  success: boolean
  durationMs: number
  retries: number
  error?: string | undefined
}

/** Condition function for branching. Returns the branch key to follow. */
export type BranchCondition = (state: Record<string, unknown>) => string

/** Merge strategy for parallel step results. */
export type ParallelMergeStrategy = 'merge' | 'concat' | 'last-wins'

/** Configuration for a loop construct in the workflow DSL. */
export interface LoopConfig {
  /** Unique identifier for this loop */
  id: string
  /** Maximum iterations before forced exit (safety bound) */
  maxIterations: number
  /** Continue looping while this returns true. Return false to exit. */
  condition: (state: Record<string, unknown>) => boolean
  /** Steps to execute each iteration */
  steps: AdapterStepConfig[]
  /** Action when maxIterations reached. Default: 'continue' */
  onMaxIterations?: 'continue' | 'fail'
}

/** Events emitted during workflow execution. */
export type AdapterWorkflowEvent =
  | { type: 'workflow:started'; workflowId: string; version?: string | undefined }
  | { type: 'step:started'; workflowId: string; stepId: string }
  | { type: 'step:completed'; workflowId: string; stepId: string; durationMs: number; providerId: string }
  | { type: 'step:failed'; workflowId: string; stepId: string; error: string; retryCount: number }
  | { type: 'step:retrying'; workflowId: string; stepId: string; attempt: number; maxRetries: number }
  | { type: 'parallel:started'; workflowId: string; stepIds: string[] }
  | { type: 'parallel:completed'; workflowId: string; stepIds: string[]; durationMs: number }
  | { type: 'branch:evaluated'; workflowId: string; selected: string }
  | { type: 'workflow:completed'; workflowId: string; durationMs: number; version?: string | undefined }
  | { type: 'step:skipped'; workflowId: string; stepId: string }
  | { type: 'workflow:failed'; workflowId: string; error: string }

/**
 * Machine-readable statement of workflow ownership. This keeps the boundary
 * testable without adding a runtime package edge to `@dzupagent/flow-compiler`.
 */
export const ADAPTER_WORKFLOW_OWNERSHIP = {
  owner: 'agent-adapters',
  canonicalContract: '@dzupagent/core:PipelineDefinition',
  runtime: '@dzupagent/agent:PipelineRuntime',
  flowCompilerDependency: 'none',
  equivalentConstructs: [
    'sequential-step-order',
    'conditional-branch-targets',
  ],
  adapterOwnedConstructs: [
    'provider-routing',
    'prompt-templating',
    'parallel-merge-strategy',
    'loop-iteration-policy',
    'adapter-workflow-events',
    'retry-and-timeout-policy',
  ],
} as const

// ---------------------------------------------------------------------------
// AdapterWorkflow (executable)
// ---------------------------------------------------------------------------

/** Options for running a workflow. */
export interface AdapterWorkflowRunOptions {
  initialState?: Record<string, unknown> | undefined
  signal?: AbortSignal | undefined
  eventBus?: DzupEventBus | undefined
  onEvent?: (event: AdapterWorkflowEvent) => void
}

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
