/**
 * _shared-composite.ts — Top-level dispatcher `lowerNodeToPipeline`.
 *
 * Routes each FlowNode variant to the appropriate per-variant lowerer in
 * sibling modules:
 *   - leaf nodes (action, for_each, clarification, complete): `_shared-leaf.ts`
 *   - control-flow nodes (sequence, branch, parallel): `_shared-control.ts`
 *   - suspend-style nodes (approval, persona, route): `_shared-suspend.ts`
 *
 * @module lower/_shared-composite
 */

import type { FlowNode } from "@dzupagent/flow-ast";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "./_shared-types.js";
import {
  lowerAction,
  lowerClarification,
  lowerComplete,
  lowerForEach,
  lowerTypedLoop,
} from "./_shared-leaf.js";
import {
  lowerBranch,
  lowerParallel,
  lowerSequence,
  lowerTryCatch,
} from "./_shared-control.js";
import { lowerApproval, lowerPersona, lowerRoute } from "./_shared-suspend.js";
import { lowerRuntimeLeaf } from "./_shared-runtime-leaf.js";
import { lowerChildren, portsOf } from "./_shared-utils.js";

/**
 * Lower a single FlowNode (and its subtree) into a flat list of
 * PipelineNode + PipelineEdge pairs.
 *
 * @param node  The FlowNode to lower.
 * @param ctx   Lowering context (resolver maps, allowForEach, idGen).
 * @param path  Dot-notation AST path (mirrors semantic stage keys) used for
 *              node naming and resolved-map lookups.
 */
export function lowerNodeToPipeline(
  node: FlowNode,
  ctx: LowerPipelineContext,
  path: string
): LowerPipelineResult {
  const result = lowerNodeVariant(node, ctx, path);
  // Every dispatched result carries ports: composites publish them
  // explicitly; leaves get the synthesized single-entry/single-exit shape.
  if (result.ports === undefined) {
    result.ports = portsOf(result);
  }
  return result;
}

function lowerNodeVariant(
  node: FlowNode,
  ctx: LowerPipelineContext,
  path: string
): LowerPipelineResult {
  switch (node.type) {
    case "sequence":
      return lowerSequence(node.nodes, ctx, path, lowerNodeToPipeline);

    case "action":
      return lowerAction(node, ctx, path, lowerNodeToPipeline);

    case "for_each":
      return lowerForEach(node, ctx, path, lowerNodeToPipeline);

    case "branch":
      return lowerBranch(node, ctx, path, lowerNodeToPipeline);

    case "parallel":
      return lowerParallel(node, ctx, path, lowerNodeToPipeline);

    case "approval":
      return lowerApproval(node, ctx, path, lowerNodeToPipeline);

    case "clarification":
      return lowerClarification(node, ctx, path);

    case "persona":
      return lowerPersona(node, ctx, path, lowerNodeToPipeline);

    case "route":
      return lowerRoute(node, ctx, path, lowerNodeToPipeline);

    case "complete":
      return lowerComplete(node, ctx, path);

    case "spawn":
    case "emit":
    case "memory":
      // Deferred to an external runtime (e.g. the Codev FlowRuntime): present in
      // the AST but not emitted as graph edges. Consumers of the lowered graph
      // should not expect these to appear as nodes/edges.
      //
      // NOTE: "deferred" is not a guarantee of execution. No in-repo executor
      // handles these types, and for `emit` specifically no emitter for the
      // `flow:emit` event exists anywhere, so an emit node is silently inert
      // unless the consuming runtime implements it. The semantic stage raises a
      // compile-time warning for `emit` (see stages/semantic-walk/dispatch.ts).
      return {
        nodes: [],
        edges: [],
        warnings: [
          `Node type "${node.type}" (id: ${JSON.stringify(
            node.id ?? path
          )}) is runtime-executed and does not appear in the lowered pipeline graph.`,
        ],
      };

    case "classify":
    case "checkpoint":
    case "restore":
    case "http":
    case "wait":
    case "subflow":
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query":
      // Runtime-executed nodes: present in AST but not emitted as graph edges.
      return { nodes: [], edges: [], warnings: [] };

    case "try_catch":
      // F-R2c: body lowers normally; the catch branch lowers onto the error
      // path via catch-all ErrorEdges from every body node.
      return lowerTryCatch(node, ctx, path, lowerNodeToPipeline);

    case "loop":
      // F-R4: a typed condition lowers to a real LoopNode carrying the
      // typedWhile contract. Legacy string-condition loops keep the
      // flattened lowering; their condition evaluation is runtime-only.
      if (node.typedCondition !== undefined) {
        return lowerTypedLoop(node, ctx, path, lowerNodeToPipeline);
      }
      return lowerChildren(
        node.body,
        ctx,
        (idx) => `${path}.body[${idx}]`,
        lowerNodeToPipeline
      );

    case "agent":
    case "validate":
    case "prompt":
    case "worker.dispatch":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
    case "set":
    case "return_to":
    case "spdd.import_sources":
    case "spdd.build_source_pack":
    case "spdd.run_analysis":
    case "spdd.generate_canvas":
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.project_plan":
    case "spdd.arm_dispatch":
    case "spdd.run_validation":
    case "spdd.collect_proof":
    case "spdd.scan_drift":
    case "spdd.create_sync_proposal":
    case "spdd.agent_swarm":
      return lowerRuntimeLeaf(node, ctx, path);

    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails here
      // at compile time. The throw below covers the runtime case the `never` guard
      // cannot: a node reaching a stale build, a hand-built AST, or a document
      // parsed from JSON. Returning an empty graph there would silently drop the
      // node AND its entire subtree with no diagnostic, so it fails closed instead.
      const _exhaustive: never = node;
      void _exhaustive;
      const unknown = node as FlowNode;
      throw new Error(
        `lower/composite: unsupported node type ${JSON.stringify(
          unknown.type
        )} at path '${path}' (id: ${JSON.stringify(
          unknown.id ?? path
        )}); lowering refuses to emit an empty graph for an unrecognized node`
      );
    }
  }
}
