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
   *    enforced only in the weak sense that `ContractNetManager` interpolates it
   *    into the CFP *prompt* text sent to bidders
   *    (`contract-net/contract-net-manager.ts` — "Required capabilities: ..."). It
   *    filters nothing: a specialist whose capabilities do not match can still
   *    bid and still win. Bid eligibility is decided by `maxCostCents` and the
   *    ranking strategy alone.
   *  - `AgentSpec.tags` (`routing-policy-types.ts`) is the tag surface that
   *    `RuleBasedRouting` actually matches on, and it is populated from
   *    `AgentExecutionSpec.metadata.tags` (`specialist-selection.ts`
   *    `toAgentSpecs`) — never from this field.
   *
   * Wiring this to bid evaluation would require inventing a match semantic
   * (subset? intersection? weighted score? hard filter or soft rank bonus?) that
   * does not exist anywhere in the codebase today, and would change which agent
   * wins a contract. That is a deliberate design decision, not a mechanical
   * hookup, so the field stays inert until such a semantic is specified.
   *
   * @see `__tests__/participant-capabilities-unused.test.ts` — pins this
   * documented no-op so the claim cannot silently rot into a lie.
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
