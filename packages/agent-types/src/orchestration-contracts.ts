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
  /** Selection strategy for choosing which specialist handles a delegation. */
  selectionStrategy?: 'round-robin' | 'capability-match' | 'load-balanced'
  /** Maximum number of concurrent delegations the supervisor may run. */
  maxDelegations?: number
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
  /** Mapper collaborators executing chunks in parallel. */
  mappers?: TAgent[]
  /** Optional reducer collaborator that consumes the merged stream. */
  reducer?: TAgent
  /** Maximum number of concurrent map operations. */
  maxConcurrency?: number
  /** Default chunk size hint for the splitter, when applicable. */
  chunkSize?: number
  /** Hook that combines per-chunk results into a single aggregate. */
  mergeFn?: (results: TResult[]) => TResult
  /** Marker preserving the chunk type for downstream specializations. */
  readonly __chunk?: TChunk
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
  /** Bidder collaborators participating in the call for proposals. */
  bidders?: TAgent[]
  /** Optional dedicated evaluator that picks the winning bid. */
  evaluator?: TAgent
  /** Maximum time (ms) to collect bids before evaluating. */
  bidTimeoutMs?: number
}
