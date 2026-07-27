/**
 * Orchestration config base contracts shared across the framework.
 *
 * These types live in `@dzupagent/agent-types` (Layer 0) so that
 * `@dzupagent/agent` and `@dzupagent/agent-adapters` can specialize a
 * single canonical shape for each multi-agent orchestration pattern
 * without duplicating field definitions that drift over time.
 *
 * Each base contract is a structural skeleton: consumers extend it via
 * type intersection to add package-specific fields (e.g. an agent-side
 * `manager: DzupAgent` or an adapter-side `registry: ProviderAdapterRegistry`).
 *
 * The optional shape is intentional — it lets both the agent-centric and
 * the registry-centric implementations specialize from the same base
 * without mismatched required fields. Specializations are free (and
 * encouraged) to tighten optionality on their own extension fields.
 *
 * SCOPE (2026-07-27): these bases carry ONLY fields that every specialization
 * actually honors. They previously declared eight behavioural knobs
 * (`selectionStrategy`, `maxDelegations`, `mappers`, `reducer`,
 * `maxConcurrency`, `chunkSize`, `mergeFn`, `bidders`, `evaluator`,
 * `bidTimeoutMs`) that NO consumer read — each specialization implements the
 * same concept under its own name. Three were actively harmful: `maxDelegations`,
 * `maxConcurrency` and `bidTimeoutMs` shadowed the live knobs
 * `maxConcurrentDelegations`, `concurrency` and `bidDeadlineMs`, so setting the
 * inherited field silently did nothing while a near-identically-named sibling
 * was the real control. They were deleted rather than wired, because wiring
 * would have created two competing knobs per concept.
 *
 * Rule for future edits: do not add a field here unless EVERY specialization
 * reads it. A knob that only one side honors belongs on that side's own
 * interface.
 *
 * IMPORTANT: This file MUST NOT import from any other `@dzupagent/*`
 * package — `@dzupagent/agent-types` sits at Layer 0 of the dependency
 * graph and runtime symbols (e.g. `DzupEventBus`) belong to higher layers.
 * Specializing packages bring those types in via intersection.
 */

/**
 * Base contract for the Supervisor orchestration pattern.
 *
 * A supervisor coordinates a set of specialists (or, in the adapter
 * world, a registry of provider adapters) to deliver a single goal.
 *
 * @typeParam TAgent - The collaborator type (e.g. `DzupAgent` for the
 *   agent package, `AgentCLIAdapter` for the adapters package).
 */
export interface BaseSupervisorContract<TAgent> {
  /** Specialist collaborators to be coordinated by the supervisor. */
  specialists?: TAgent[]
}

/**
 * Base contract for the Map-Reduce orchestration pattern.
 *
 * A map-reduce execution fans out work across `mappers` (or registry-
 * backed equivalents), then folds the per-chunk results into a single
 * aggregate using the reducer/merge function.
 *
 * @typeParam TAgent  - The collaborator type used for map operations.
 * @typeParam TChunk  - The per-unit input type passed to each mapper.
 * @typeParam TResult - The per-unit result type the reducer consumes.
 */
export interface BaseMapReduceContract<TAgent, TChunk = unknown, TResult = unknown> {
  /** Marker preserving the chunk type for downstream specializations. */
  readonly __chunk?: TChunk
  /** Marker preserving the result type for downstream specializations. */
  readonly __result?: TResult
  /** Marker preserving the collaborator type for downstream specializations. */
  readonly __agent?: TAgent
}

/**
 * Base contract for the FIPA Contract-Net orchestration pattern.
 *
 * Contract-Net coordinates work via competitive bidding: bidders submit
 * proposals, an evaluator selects a winner, and the winner executes.
 *
 * @typeParam TAgent - The collaborator type used for bidding/execution.
 */
export interface BaseContractNetContract<TAgent> {
  /** Marker preserving the collaborator type for downstream specializations. */
  readonly __agent?: TAgent
}


/**
 * Base contract for the Team-Coordination orchestration pattern family.
 *
 * Captures the structural shape of a coordination strategy that the
 * `TeamRuntime` (in `@dzupagent/agent`) dispatches to per
 * `coordinatorPattern`. The runtime owns lifecycle / OTel / policy
 * validation; each pattern implementation owns the participant scheduling
 * and merge semantics for one specific pattern.
 *
 * This contract is intentionally structural (no class import) so the
 * agent-types layer stays free of runtime symbols. The `@dzupagent/agent`
 * package narrows the generic params (`TContext`, `TResult`,
 * `TCheckpoint`) to its concrete `TeamPatternContext` /
 * `TeamPatternResult` / `TeamCheckpoint` types.
 *
 * @typeParam TPatternId  - The coordinator pattern identifier (e.g. the
 *   `CoordinatorPattern` union from `@dzupagent/agent`).
 * @typeParam TContext    - The execution context the pattern receives
 *   (participants, workspace, circuit breaker, span, ...).
 * @typeParam TResult     - The result the pattern returns to the runtime.
 * @typeParam TCheckpoint - The checkpoint shape consumed by `resume`.
 */
export interface BaseTeamCoordinationContract<
  TPatternId extends string,
  TContext,
  TResult,
  TCheckpoint = unknown,
> {
  /** Stable pattern identifier — must match the `coordinatorPattern`. */
  readonly id: TPatternId
  /** Run the pattern against a fresh task. */
  execute(ctx: TContext): Promise<TResult>
  /** Optional: resume from a previously persisted checkpoint. */
  resume?(ctx: TContext, checkpoint: TCheckpoint): Promise<TResult>
}
