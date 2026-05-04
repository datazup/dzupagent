/**
 * PipelineExecutorPort -- dependency-inverted interface that the
 * adapter-workflow layer uses to execute compiled pipeline definitions
 * without statically depending on the concrete `PipelineRuntime` class.
 *
 * This port lives in `@dzupagent/adapter-types` (a layer-0 type-only
 * package) so that:
 *
 *   - `@dzupagent/agent-adapters` (callers / workflow builders) can
 *     depend on the port and accept any compatible executor via DI.
 *   - `@dzupagent/agent` (the canonical implementation) can declare
 *     `PipelineRuntime` as an implementation of this port.
 *   - Third-party or test doubles can implement the same shape without
 *     pulling in the full agent runtime.
 *
 * Scope: this port only models the methods that callers in
 * `@dzupagent/agent-adapters` actually use today. It is intentionally
 * minimal -- richer runtime concerns (checkpoints, recovery copilots,
 * tracers) remain owned by the concrete runtime configuration type.
 */
// ---------------------------------------------------------------------------
// Result / context shapes
//
// These are structural duplicates of the corresponding types exported by
// `@dzupagent/agent`. Keeping them here lets adapter-types remain the
// single layer-0 contract without taking a dependency on the orchestrator
// package. Concrete implementations (e.g. `PipelineRuntime`) are
// structurally compatible with these shapes.
// ---------------------------------------------------------------------------

/** Lifecycle state of a pipeline run, shared with `@dzupagent/agent`. */
export type PipelineExecutorState =
  | 'idle'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Result produced by a single pipeline node executor invocation. */
export interface PipelineExecutorNodeResult {
  nodeId: string
  output: unknown
  durationMs: number
  error?: string
}

/** Aggregate result returned by `PipelineExecutorPort.execute`. */
export interface PipelineExecutorRunResult {
  pipelineId: string
  runId: string
  state: PipelineExecutorState
  nodeResults: Map<string, PipelineExecutorNodeResult>
  totalDurationMs: number
  budgetUsed?: { tokens: number; costCents: number }
}

/** Per-node execution context provided to the node executor function. */
export interface PipelineExecutorNodeContext {
  state: Record<string, unknown>
  previousResults: Map<string, PipelineExecutorNodeResult>
  signal?: AbortSignal
  budget?: { tokensRemaining: number; costRemainingCents: number }
  stuckHint?: string
}

/**
 * Function executed for each node in the pipeline. Implementations are
 * provided by the workflow builder; the executor port simply invokes them.
 *
 * The `node` argument is parameterised so this port does not leak the full
 * `PipelineNode` discriminated union -- callers that need the typed shape
 * pass it as `TNode` (typically the `PipelineNode` from `@dzupagent/core`).
 * Defaults to `unknown` for callers that are content with a structural shape.
 */
export type PipelineExecutorNodeRunner<TNode = unknown> = (
  nodeId: string,
  node: TNode,
  context: PipelineExecutorNodeContext,
) => Promise<PipelineExecutorNodeResult>

/**
 * Subset of `PipelineRuntimeEvent` that adapter-workflow consumers care
 * about. Concrete runtimes may emit a richer event union -- consumers must
 * branch on `type` and ignore unknown shapes.
 */
export interface PipelineExecutorEvent {
  type: string
  [key: string]: unknown
}

/**
 * Minimal configuration accepted by a `PipelineExecutorFactory`.
 *
 * Mirrors the fields of `PipelineRuntimeConfig` that adapter-workflow
 * actually populates today. Implementations are free to accept additional
 * fields, but adapter-types only contracts on these.
 */
export interface PipelineExecutorConfig<TDefinition = unknown, TNode = unknown> {
  /**
   * Pipeline definition to execute.
   *
   * Typed as a generic parameter so adapter-types can stay free of any
   * dependency on `@dzupagent/core`. Concrete callers (e.g. the
   * adapter-workflow builder) parameterise the port with the canonical
   * `PipelineDefinition` shape, while adapter-types only contracts on
   * the port surface.
   */
  definition: TDefinition
  /** Function that executes individual nodes. */
  nodeExecutor: PipelineExecutorNodeRunner<TNode>
  /** Named predicate functions for conditional edges and loops. */
  predicates?: Record<string, (state: Record<string, unknown>) => boolean>
  /** Cancellation signal for the run. */
  signal?: AbortSignal
  /** Event callback invoked for each runtime event. */
  onEvent?: (event: PipelineExecutorEvent) => void
}

// ---------------------------------------------------------------------------
// Port surface
// ---------------------------------------------------------------------------

/**
 * Executor handle produced by a `PipelineExecutorFactory`. Mirrors the
 * subset of `PipelineRuntime` used by `AdapterWorkflowBuilder`.
 */
export interface PipelineExecutorPort {
  /**
   * Execute the configured pipeline definition from its entry node.
   *
   * Implementations must respect cancellation via the configured signal
   * and return a result describing the terminal state.
   */
  execute(
    initialState?: Record<string, unknown>,
  ): Promise<PipelineExecutorRunResult>
}

/**
 * Factory that constructs a `PipelineExecutorPort` for a given config.
 *
 * Adapter-workflow code accepts this factory via DI so it never imports
 * the concrete `PipelineRuntime` class. The default factory is provided
 * by `@dzupagent/agent`.
 */
export type PipelineExecutorFactory<TDefinition = unknown, TNode = unknown> = (
  config: PipelineExecutorConfig<TDefinition, TNode>,
) => PipelineExecutorPort
