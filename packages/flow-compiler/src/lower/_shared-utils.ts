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
  LoweringMode,
} from "./_shared-types.js";

export function freshId(ctx: LowerPipelineContext): string {
  return ctx.idGen !== undefined ? ctx.idGen() : crypto.randomUUID();
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
  let pendingTailNodeIds: string[] = [];
  for (const part of parts) {
    const firstNode = part.nodes[0];
    if (firstNode !== undefined) {
      for (const tailId of pendingTailNodeIds) {
        merged.edges.push(seqEdge(tailId, firstNode.id));
      }
    }

    const lastNode = part.nodes[part.nodes.length - 1];
    if (part.tailNodeIds !== undefined && part.tailNodeIds.length > 0) {
      pendingTailNodeIds = part.tailNodeIds;
    } else if (lastNode !== undefined) {
      pendingTailNodeIds = [lastNode.id];
    }
  }

  return merged;
}
