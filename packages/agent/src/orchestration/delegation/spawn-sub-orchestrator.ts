/**
 * Sub-orchestrator spawning for `DelegatingSupervisor` (ORCHESTRATION_V2).
 *
 * The spawning supervisor is the only authority on a child's position in the
 * orchestration tree, so this module derives the child hierarchy from the
 * spawner and treats the caller's `parentRunId`/`depth` as assertions to be
 * checked rather than inputs to be trusted. Split out of
 * `delegating-supervisor.ts`, which keeps leaf delegation and planning.
 *
 * @module orchestration/delegation/spawn-sub-orchestrator
 */
import { OrchestrationError } from "../orchestration-error.js";
import type {
  SubOrchestratorChildHierarchy,
  SubOrchestratorSpawnOptions,
} from "../delegating-supervisor-types.js";
import { assertDepthAllowed as assertOrchestrationDepthAllowed } from "../delegating-supervisor-types.js";
import type {
  SubOrchestratorFactory,
  SubOrchestratorSpawnResult,
} from "../delegating-supervisor.js";

/**
 * The spawner state a child's hierarchy is derived from. Narrow by design: the
 * spawn decision must not be able to reach the rest of the supervisor.
 */
export interface SpawnerContext {
  hierarchyDepth: number;
  ownRunId: string | undefined;
  subOrchestratorFactory: SubOrchestratorFactory | undefined;
}

/**
 * Dispatch a subtask to a CHILD `DelegatingSupervisor`.
 *
 * This is the recursive half of the orchestration hierarchy: unlike
 * {@link delegateTask}, whose target is a specialist *leaf*, this descends one
 * orchestrator level. It is the site the depth ceiling exists for.
 *
 * ## Depth enforcement
 *
 * `assertDepthAllowed(sc.hierarchyDepth + 1)` runs FIRST, before the factory
 * is invoked and before any child is constructed — the CHILD's prospective
 * depth, not the spawner's.
 *
 * That choice is forced, not stylistic. `assertDepthAllowed(d)` throws when
 * `d >= MAX_ORCHESTRATION_DEPTH` (3), and the constructor already applies it
 * to a supervisor's own depth, so constructable depths are {0, 1, 2}.
 * Guarding the *spawner's* depth here would let a depth-2 supervisor pass and
 * then produce a depth-3 child that the child constructor must reject: the
 * dispatch site would be reporting "allowed" for a spawn that cannot
 * complete. Guarding the child's depth makes the dispatch-site verdict
 * truthful — if this method gets past the guard, the child is constructable.
 *
 * Stated plainly: **depth 1 is the deepest a supervisor may spawn FROM**,
 * because depth 2 is the deepest a supervisor may exist AT. A depth-2
 * supervisor is a valid leaf orchestrator; it delegates to specialists and
 * spawns no children.
 *
 * ## Hierarchy propagation
 *
 * The child receives:
 *  - `parentRunId` = THIS supervisor's own run ID (`config.runId`) — the
 *    ORCHESTRATOR-hierarchy parent, concept (1) in the {@link hierarchy}
 *    docblock. It is NOT taken from `parentContext.parentRunId`, which is the
 *    per-delegation parent, concept (2). Conflating them is explicitly
 *    rejected; a supervisor with no `runId` cannot name itself a parent and
 *    this method throws instead of substituting concept (2).
 *  - `branchId` = `options.branchId`, verbatim.
 *  - `depth`    = this supervisor's depth + 1.
 *
 * Caller-supplied `options.parentRunId` / `options.depth` are treated as
 * assertions, not inputs: they are compared against the derived values and a
 * mismatch throws, so a caller working from a stale view of the tree fails
 * loudly rather than spawning a mis-attributed child.
 *
 * ## Events
 *
 * This method deliberately emits NO event of its own. See the "Sub-orchestrator
 * spawning" section of the {@link hierarchy} docblock for the reasoning.
 *
 * @throws OrchestrationError when no factory is available, when `runId` is
 *   unset, when the caller's asserted hierarchy disagrees with the derived
 *   one, or when the factory returns a child whose hierarchy does not match.
 * @throws Error (from `assertDepthAllowed`) when the depth ceiling is reached.
 */
export async function spawnSubOrchestrator(
  sc: SpawnerContext,
  options: SubOrchestratorSpawnOptions,
  factory?: SubOrchestratorFactory
): Promise<SubOrchestratorSpawnResult> {
  // ── 1. Depth guard, AT THE DISPATCH SITE, before anything is built. ──
  //
  // The guard is on the CHILD's prospective depth, not the spawner's. Two
  // readings of `assertDepthAllowed` were available and they are NOT
  // equivalent; this one is forced by the pre-existing constructor guard.
  //
  // `assertDepthAllowed(d)` throws when `d >= MAX_ORCHESTRATION_DEPTH` (3),
  // and the constructor already applies it to a supervisor's own depth. So
  // the set of constructable depths is {0, 1, 2}: three levels, which is what
  // makes 3 the level *count*. Guarding the spawner's depth instead would let
  // a depth-2 supervisor pass this check and then hand the factory a child at
  // depth 3 that the child constructor must reject — the dispatch site would
  // report "allowed" for a spawn that cannot possibly complete. Guarding the
  // child's depth keeps the dispatch-site verdict truthful: if this returns,
  // the child is constructable.
  //
  // Consequence, stated plainly: depth 1 is the deepest a supervisor may
  // spawn FROM, because depth 2 is the deepest a supervisor may exist AT.
  const childDepth = sc.hierarchyDepth + 1;
  assertOrchestrationDepthAllowed(childDepth);

  const resolvedFactory = factory ?? sc.subOrchestratorFactory;
  if (!resolvedFactory) {
    throw new OrchestrationError(
      "Cannot spawn a sub-orchestrator: no subOrchestratorFactory was " +
        "configured and none was passed to spawnSubOrchestrator(). The " +
        "child's specialists and delegation tracker are wiring decisions " +
        "this supervisor cannot invent.",
      "delegation",
      { branchId: options.branchId, depth: childDepth }
    );
  }

  // ── 2. Derive the child's hierarchy from THIS supervisor. ──
  if (sc.ownRunId === undefined) {
    throw new OrchestrationError(
      "Cannot spawn a sub-orchestrator: this supervisor has no `runId`, so " +
        "it cannot name itself as the child's orchestrator-hierarchy parent. " +
        "Set DelegatingSupervisorConfig.runId. Note this is NOT " +
        "parentContext.parentRunId, which is the per-delegation parent and " +
        "would mis-attribute the tree.",
      "delegation",
      { branchId: options.branchId, depth: childDepth }
    );
  }

  const hierarchy: SubOrchestratorChildHierarchy = {
    parentRunId: sc.ownRunId,
    branchId: options.branchId,
    depth: childDepth,
  };

  // ── 3. Validate the caller's asserted position against the derived one. ──
  if (options.parentRunId !== hierarchy.parentRunId) {
    throw new OrchestrationError(
      `Sub-orchestrator spawn rejected: options.parentRunId ` +
        `"${options.parentRunId}" does not match this supervisor's run ` +
        `"${hierarchy.parentRunId}". The spawning supervisor is the only ` +
        "authority on the child's orchestrator-hierarchy parent.",
      "delegation",
      {
        expectedParentRunId: hierarchy.parentRunId,
        actualParentRunId: options.parentRunId,
      }
    );
  }
  if (options.depth !== hierarchy.depth) {
    throw new OrchestrationError(
      `Sub-orchestrator spawn rejected: options.depth ${options.depth} does ` +
        `not match the derived child depth ${hierarchy.depth} ` +
        `(spawner depth ${sc.hierarchyDepth} + 1).`,
      "delegation",
      { expectedDepth: hierarchy.depth, actualDepth: options.depth }
    );
  }

  // ── 4. Build the child and verify the factory honored the hierarchy. ──
  const child = await resolvedFactory({ hierarchy, options });
  const actual = child.hierarchy;
  if (
    actual.parentRunId !== hierarchy.parentRunId ||
    actual.branchId !== hierarchy.branchId ||
    actual.depth !== hierarchy.depth
  ) {
    throw new OrchestrationError(
      "Sub-orchestrator factory returned a child whose hierarchy does not " +
        "match the derived one. The factory must spread the supplied " +
        "`hierarchy` onto the child config verbatim.",
      "delegation",
      { expected: hierarchy, actual }
    );
  }

  // ── 5. Run the child. Failures propagate to this caller unchanged. ──
  const result = await child.planAndDelegate(options.inputPrompt);

  return { hierarchy, supervisor: child, result };
}
