/**
 * _shared-utils.ts — Internal helpers for the shared lowering pipeline:
 * fresh IDs, mode selection, edge construction, child merging.
 *
 * @module lower/_shared-utils
 */

import type { FlowNode } from "@dzupagent/flow-ast";
import type {
  PipelineEdge,
  PipelineNode,
  SequentialEdge,
} from "@dzupagent/core/orchestration";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
  LoweredPorts,
  LoweringMode,
} from "./_shared-types.js";

export function freshId(ctx: LowerPipelineContext): string {
  return ctx.idGen !== undefined ? ctx.idGen() : crypto.randomUUID();
}

/**
 * The effective tails of a result under the shipped contract: the explicit
 * `tailNodeIds`, or the last-node fallback when absent. This is the exact
 * rule the stitching engine applies; `ports.normalExits` must equal it.
 */
export function effectiveTails(result: LowerPipelineResult): string[] {
  if (result.tailNodeIds !== undefined) return result.tailNodeIds;
  const lastNode = result.nodes[result.nodes.length - 1];
  return lastNode !== undefined ? [lastNode.id] : [];
}

/**
 * A result's ports, synthesizing the default single-entry shape for results
 * that did not publish them (plain leaves): entry = first node, normal exits
 * = effective tails, no suspended/terminal/error exits.
 */
export function portsOf(result: LowerPipelineResult): LoweredPorts {
  if (result.ports !== undefined) return result.ports;
  const firstNode = result.nodes[0];
  return {
    entryNodeIds: firstNode !== undefined ? [firstNode.id] : [],
    normalExits: effectiveTails(result),
    suspendedExits: [],
    terminalExits: [],
    errorExits: [],
  };
}

export function loweringMode(ctx: LowerPipelineContext): LoweringMode {
  return ctx.mode ?? "executable";
}

export function seqEdge(
  sourceNodeId: string,
  targetNodeId: string
): SequentialEdge {
  return { type: "sequential", sourceNodeId, targetNodeId };
}

/**
 * Chain a linear sequence of node IDs with sequential edges.
 * Returns edges connecting each consecutive pair.
 */
export function chainEdges(nodeIds: string[]): SequentialEdge[] {
  const edges: SequentialEdge[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const src = nodeIds[i];
    const tgt = nodeIds[i + 1];
    // noUncheckedIndexedAccess: both are defined by loop bounds
    if (src !== undefined && tgt !== undefined) {
      edges.push(seqEdge(src, tgt));
    }
  }
  return edges;
}

/**
 * Merge an array of LowerPipelineResult into a single accumulator result.
 * Does NOT add any inter-result edges — callers are responsible for stitching.
 */
export function mergeResults(
  parts: LowerPipelineResult[]
): LowerPipelineResult {
  const nodes: PipelineNode[] = [];
  const edges: PipelineEdge[] = [];
  const warnings: string[] = [];
  for (const part of parts) {
    nodes.push(...part.nodes);
    edges.push(...part.edges);
    warnings.push(...part.warnings);
  }
  return { nodes, edges, warnings };
}

/**
 * Lower an array of children using a per-index path generator. Concatenates
 * nodes/edges/warnings and threads sequential edges between consecutive
 * children (last node of part[i] → first node of part[i+1]).
 *
 * This is the workhorse used by every composite lowerer.
 */
export function lowerChildren(
  children: FlowNode[],
  ctx: LowerPipelineContext,
  childPath: (idx: number) => string,
  lowerOne: (
    child: FlowNode,
    ctx: LowerPipelineContext,
    path: string
  ) => LowerPipelineResult
): LowerPipelineResult {
  if (children.length === 0) {
    return { nodes: [], edges: [], warnings: [] };
  }

  const parts: LowerPipelineResult[] = children.map((child, idx) =>
    lowerOne(child, ctx, childPath(idx))
  );

  const merged = mergeResults(parts);

  // Add sequential edges between executable child parts. Some DSL nodes lower
  // to no pipeline nodes (for example `set` today), so bridge across those
  // empty parts rather than letting the executable chain stop early.
  //
  // An explicit empty tailNodeIds array means the part is terminal (e.g.
  // `complete`): nothing may be wired after it, and any later sibling that
  // still produces nodes is unreachable.
  let pendingTailNodeIds: string[] = [];
  let afterTerminal = false;
  for (const part of parts) {
    const firstNode = part.nodes[0];
    if (firstNode !== undefined) {
      if (afterTerminal) {
        merged.warnings.push(
          `lower/children: node '${firstNode.id}' is unreachable — it follows a terminal sibling (e.g. complete) and receives no incoming edge`
        );
        afterTerminal = false;
      }
      for (const tailId of pendingTailNodeIds) {
        merged.edges.push(seqEdge(tailId, firstNode.id));
      }
    }

    const lastNode = part.nodes[part.nodes.length - 1];
    // Empty tailNodeIds only means "terminal" when the part produced nodes;
    // a node-less part with empty tails is transparent (bridge across it).
    if (
      part.tailNodeIds !== undefined &&
      (part.tailNodeIds.length > 0 || lastNode !== undefined)
    ) {
      pendingTailNodeIds = part.tailNodeIds;
      if (part.tailNodeIds.length === 0) {
        afterTerminal = true;
      }
    } else if (lastNode !== undefined) {
      pendingTailNodeIds = [lastNode.id];
    }
  }

  // Expose this subtree's exit points so containing composites stitch their
  // continuation from the true tails (all branch exits; none after a terminal
  // part) instead of the flat last-node fallback. A list that lowered to zero
  // nodes stays transparent (no tails claimed) so parents bridge across it.
  if (merged.nodes.length > 0) {
    merged.tailNodeIds = pendingTailNodeIds;

    // Compose ports across the children: control enters at the first part
    // that produced nodes; suspended/terminal/error exits accumulate from
    // every child; normal exits are exactly the tails computed above.
    const suspendedExits: string[] = [];
    const terminalExits: string[] = [];
    const errorExits: string[] = [];
    let entryNodeIds: string[] = [];
    for (const part of parts) {
      const ports = portsOf(part);
      if (entryNodeIds.length === 0 && part.nodes.length > 0) {
        entryNodeIds = ports.entryNodeIds;
      }
      suspendedExits.push(...ports.suspendedExits);
      terminalExits.push(...ports.terminalExits);
      errorExits.push(...ports.errorExits);
    }
    merged.ports = {
      entryNodeIds,
      normalExits: pendingTailNodeIds,
      suspendedExits,
      terminalExits,
      errorExits,
    };
  }

  return merged;
}
