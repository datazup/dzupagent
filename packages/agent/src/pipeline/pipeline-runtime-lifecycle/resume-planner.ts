/**
 * Resume/recovery graph analysis for the pipeline runtime.
 *
 * Extracted from `pipeline-runtime.ts` (DZUPAGENT-ARCH-M-06). These are the
 * pure graph-walk helpers `resume()`/`recoverAfterProcessRestart()` use to
 * decide *where* to re-enter a partially-completed run: locating a mid-flight
 * loop or fork, finding the first not-yet-completed restart node, and counting
 * how many nodes a resume would replay (for the `maxReplayNodes` budget).
 *
 * They hold no runtime state — the runtime passes a small `ResumePlannerCtx`
 * exposing the node map, definition, and its own edge-resolution closure so
 * the "next node" logic stays identical to traversal time.
 *
 * @module pipeline/pipeline-runtime-lifecycle/resume-planner
 */

import type { PipelineNode } from "@dzupagent/core/pipeline";
import type { PipelineRuntimeConfig } from "../pipeline-runtime-types.js";

/**
 * Read-only view the resume planners need over the owning runtime. Kept
 * minimal so these helpers stay independently testable and free of lifecycle
 * state.
 */
export interface ResumePlannerCtx {
  readonly nodeMap: Map<string, PipelineNode>;
  readonly definition: PipelineRuntimeConfig["definition"];
  /**
   * Resolve the node(s) immediately after `nodeId`, mirroring traversal-time
   * edge resolution exactly so resume behaviour is indistinguishable from a
   * fresh `execute()`.
   */
  getNextNodeIds(nodeId: string, runState: Record<string, unknown>): string[];
}

/**
 * Find a loop node that was mid-flight when the checkpoint was written: it has
 * a recorded iteration cursor but is not yet in `completedNodeIds` (the loop
 * node is only marked complete when the whole loop finishes). Returns its node
 * ID, or undefined when no loop is mid-flight.
 */
export function findMidFlightLoopNodeId(
  ctx: ResumePlannerCtx,
  loopState: Record<string, { iteration: number }>,
  completedNodeIds: string[]
): string | undefined {
  const completed = new Set(completedNodeIds);
  for (const nodeId of Object.keys(loopState)) {
    const node = ctx.nodeMap.get(nodeId);
    if (node?.type === "loop" && !completed.has(nodeId)) return nodeId;
  }
  return undefined;
}

/**
 * Find a fork node that was mid-flight when the checkpoint was written: its
 * `forkState` entry survived (the fork clears it only after the join
 * completes). Returns the fork node's ID, or undefined when no fork is
 * mid-flight. Mirrors `findMidFlightLoopNodeId` (W3).
 */
export function findMidFlightForkNodeId(
  ctx: ResumePlannerCtx,
  forkState: Record<string, { branches: Record<string, unknown> }>
): string | undefined {
  for (const node of ctx.definition.nodes) {
    if (node.type !== "fork") continue;
    if (forkState[node.forkId]) return node.id;
  }
  return undefined;
}

/**
 * Walk forward from the entry node past already-completed nodes and return the
 * first node that has not completed yet, or undefined when the whole reachable
 * chain is done.
 */
export function findRestartNodeId(
  ctx: ResumePlannerCtx,
  completedNodeIds: string[],
  runState: Record<string, unknown>
): string | undefined {
  const completed = new Set(completedNodeIds);
  let candidate: string | undefined = ctx.definition.entryNodeId;
  const visited = new Set<string>();

  while (candidate && completed.has(candidate) && !visited.has(candidate)) {
    visited.add(candidate);
    candidate = ctx.getNextNodeIds(candidate, runState)[0];
  }

  return candidate && !completed.has(candidate) ? candidate : undefined;
}

/**
 * Count the not-yet-completed nodes reachable from `startNodeId`, i.e. how many
 * nodes a resume beginning there would replay. Used to enforce the
 * `resume.maxReplayNodes` budget.
 */
export function countReplayNodesFrom(
  ctx: ResumePlannerCtx,
  startNodeId: string,
  runState: Record<string, unknown>,
  completedNodeIds: string[]
): number {
  const completed = new Set(completedNodeIds);
  const visited = new Set<string>();
  const stack = [startNodeId];
  let count = 0;

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    if (completed.has(nodeId)) continue;

    count += 1;
    stack.push(...ctx.getNextNodeIds(nodeId, runState));
  }

  return count;
}
