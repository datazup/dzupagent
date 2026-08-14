/**
 * _shared-types.ts — Public types and handle re-exports for the shared
 * lowering helper.
 *
 * Re-exported via the `_shared.ts` barrel; callers should import from
 * `_shared.ts` to keep the public surface stable.
 *
 * @module lower/_shared-types
 */

import type {
  AgentHandle,
  McpToolHandle,
  SkillHandle,
  WorkflowHandle,
} from "@dzupagent/core/advanced";
import type { ResolvedTool } from "@dzupagent/flow-ast";
import type { PipelineEdge, PipelineNode } from "@dzupagent/core/orchestration";

// Re-export handle types for internal consumers that previously imported
// them from `_shared.ts`. Keeps the public surface of that module stable
// while the canonical definitions live in `@dzupagent/core/advanced`.
export type { AgentHandle, McpToolHandle, SkillHandle, WorkflowHandle };

// ---------------------------------------------------------------------------
// Context and result types
// ---------------------------------------------------------------------------

export type LoweringMode = "executable" | "diagnostic";

export interface LowerPipelineContext {
  resolved: Map<string, ResolvedTool>;
  resolvedPersonas: Map<string, string>;
  /**
   * Executable lowering is fail-closed: unresolved semantic references must not
   * become runtime nodes. Diagnostic lowering keeps best-effort stub emission.
   */
  mode?: LoweringMode;
  /**
   * lower-pipeline-flat passes false; lower-pipeline-loop passes true.
   * When false, encountering a for_each node throws a router-contract error.
   */
  allowForEach: boolean;
  /**
   * ID generator for fresh node IDs.
   * Defaults to crypto.randomUUID when not provided.
   */
  idGen?: () => string;
}

export interface LowerPipelineResult {
  /**
   * Flat list of PipelineNode objects produced by lowering this subtree.
   * Consumers accumulate these into PipelineDefinition.nodes.
   *
   * Type: PipelineNode[]
   */
  nodes: PipelineNode[];
  /**
   * Flat list of PipelineEdge objects produced by lowering this subtree.
   * Consumers accumulate these into PipelineDefinition.edges.
   */
  edges: PipelineEdge[];
  warnings: string[];
  /**
   * When a subtree has multiple exit points (e.g. branch: then-tail + else-tail
   * or then-tail + gate for the false-path), this lists all node IDs that must
   * receive a sequential edge to the next sibling in a containing sequence.
   *
   * An explicit empty array means the subtree is terminal (e.g. `complete`):
   * it has no exit points and nothing may be wired after it.
   *
   * When absent, the stitching logic falls back to `nodes[nodes.length - 1]`
   * (the default single-tail behaviour).
   */
  tailNodeIds?: string[];
  /**
   * Structured port sets (doc 14 §7 R2) — a refinement OVER the tails
   * contract, never a replacement: `ports.normalExits` is always identical to
   * the effective tails (`tailNodeIds` or the last-node fallback), and the
   * stitching engine still wires from tails. The ports make the outcome
   * classes the flat tail array erases distinguishable again: which exits
   * continue, which suspend forever, and which end the flow.
   */
  ports?: LoweredPorts;
}

/**
 * Outcome-classified boundary nodes of one lowered subtree.
 *
 * Every lowered fragment gets ports: composites publish them explicitly;
 * plain leaves get synthesized single-entry/single-exit ports at the
 * dispatcher (`lowerNodeToPipeline`).
 */
export interface LoweredPorts {
  /**
   * Node ids that receive control when the fragment is entered. At most one
   * today (branch → gate, parallel → fork, persona/route/complete → suspend,
   * sequence → first child's entry); empty when the fragment lowered to zero
   * nodes (runtime-transparent leaves).
   */
  entryNodeIds: string[];
  /**
   * Exits that continue into the next sibling — identical to the effective
   * tails contract by invariant.
   */
  normalExits: string[];
  /**
   * Exits where a path stops awaiting an external decision WITH NO lowered
   * continuation, e.g. an approval gate without `onReject`: the rejected
   * outcome dead-ends at the gate by design. (A suspend that resumes into a
   * continuation is a normal exit, not a suspended one.)
   */
  suspendedExits: string[];
  /** Every approval/clarification suspension point, regardless of exit class. */
  suspensionSites: string[];
  /**
   * Lowered `complete` nodes: the flow deliberately ends here. Propagated
   * upward through every composite — including `for_each`, whose body tails
   * the loop contract otherwise discards.
   */
  terminalExits: string[];
  /**
   * Error-path landings (F-R2c): the continuing tails of lowered
   * `try_catch.catch` fragments — the nodes where control rejoins the flow
   * after a handled error. Accumulated upward through composites exactly
   * like suspended/terminal exits; unlike those, an error exit CONTINUES (a
   * handled error resumes), so at the fragment whose boundary the catch
   * reaches these ids also appear among the normal tails. A catch that ends
   * terminally (`complete`) or suspends contributes to
   * `terminalExits`/`suspendedExits` instead.
   */
  errorExits: string[];
}
