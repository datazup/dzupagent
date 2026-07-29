/**
 * Team definition types — declarative schema for multi-agent teams.
 *
 * A `TeamDefinition` is a pure data structure that describes *what* the team
 * is (participants, coordination pattern, identity). Runtime concerns such as
 * execution policies, governance, and memory live in `team-policy.ts`, while
 * the actual execution engine lives in `team-runtime.ts`.
 *
 * Keeping definition and policy separate lets the same team shape be reused
 * across different environments (sandboxed vs. live, ephemeral vs. persistent)
 * without duplicating the participant list.
 */

/**
 * The coordination pattern the team uses to make progress on a task.
 *
 * - `supervisor`: A manager agent delegates to specialists via tool calls.
 * - `contract_net`: Participants bid on tasks; a manager awards contracts.
 * - `blackboard`: Participants share a workspace and iterate in rounds.
 * - `peer_to_peer`: Participants run in parallel; results are merged.
 * - `council`: Participants deliberate; a judge picks the best answer.
 */
export type CoordinatorPattern =
  | "supervisor"
  | "contract_net"
  | "blackboard"
  | "peer_to_peer"
  | "council";

/** Declarative config for a single team participant. */
export interface ParticipantDefinition {
  /** Stable participant ID, unique within the team. */
  id: string;
  /** Role this participant plays (e.g. 'planner', 'reviewer', 'specialist'). */
  role: string;
  /** Model identifier, e.g. 'claude-sonnet-4-6'. */
  model: string;
  /** Optional system prompt override for this participant. */
  systemPrompt?: string;
  /**
   * Capability tags for this participant.
   *
   * RESERVED AND CURRENTLY UNUSED — nothing reads this field. It is accepted,
   * carried on the definition, and never consulted by any routing, matching, or
   * bid-evaluation code path. Setting it has no effect on which participant is
   * selected for a task.
   *
   * Do NOT confuse this with the two adjacent, *live* capability surfaces:
   *
   *  - `TeamPolicies.contractNet.requiredCapabilities` (`team-policy.ts`) is
   *    fully enforced: `ContractNetManager` interpolates it into the CFP prompt
   *    AND filters the returned bids by it before ranking
   *    (`contract-net/contract-net-manager.ts` `filterBidsByCapabilities`). A
   *    bid wins only if it declares every required capability. Note the match
   *    is against the capabilities a bidder self-reports IN ITS BID, which is
   *    a different surface from this field — nothing propagates a participant
   *    definition into its own bid.
   *  - `AgentSpec.tags` (`routing-policy-types.ts`) is the tag surface that
   *    `RuleBasedRouting` actually matches on, and it is populated from
   *    `AgentExecutionSpec.metadata.tags` (`specialist-selection.ts`
   *    `toAgentSpecs`) — never from this field.
   *
   * The match semantic this docstring once called unspecified now exists:
   * contract-net requires a SUBSET match and enforces it as a hard
   * pre-ranking filter, mirroring `maxCostCents`. What is still missing is a
   * *trust* decision, and that is why this field remains inert. The filter
   * matches on capabilities a bidder SELF-REPORTS, which an agent can
   * overclaim. Feeding this operator-authored field into that match would
   * silently convert it from a declaration into an entitlement — every
   * participant would automatically satisfy requirements naming the tags its
   * own definition lists, regardless of what it can do.
   *
   * Wiring it therefore means deciding whether a participant definition is
   * evidence of capability or merely a claim about it, and that is an
   * operator-facing policy question, not a mechanical hookup.
   *
   * @see `__tests__/participant-capabilities-vs-bid-capabilities.test.ts` —
   * pins this no-op, and the gap between it and the enforced bid-side filter,
   * so neither claim can silently rot into a lie.
   */
  capabilities?: string[];
}

/** Declarative config for an entire team. */
export interface TeamDefinition {
  /** Stable team ID. */
  id: string;
  /** Human-readable team name. */
  name: string;
  /** Coordination pattern the runtime will use. */
  coordinatorPattern: CoordinatorPattern;
  /** Participants in the team, in declaration order. */
  participants: ParticipantDefinition[];
  /** Optional human-readable description. */
  description?: string;
}
