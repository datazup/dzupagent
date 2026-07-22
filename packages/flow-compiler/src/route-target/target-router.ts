import type { FlowNode } from "@dzupagent/flow-ast";

import type { CompilationTarget } from "../types.js";

/**
 * D2 — Feature bitmask (canonical).
 *
 * Each bit represents a structural feature whose presence affects which
 * compilation target the flow must lower to. The bitmask is computed in a
 * single recursive walk, OR-ing bits as the walker descends. Subtree purity
 * never downgrades the enclosing program: an all-sequential subtree inside a
 * `branch` still escalates the whole flow to the `workflow-builder` target.
 */
export const FEATURE_BITS = {
  SEQUENTIAL_ONLY: 0,
  BRANCH: 1 << 0, // 1
  PARALLEL: 1 << 1, // 2
  SUSPEND: 1 << 2, // 4    (approval | clarification | persona | route)
  FOR_EACH: 1 << 3, // 8
  RUNTIME_LEAF: 1 << 4, // 16   (agent | validate | adapter.* | implementation primitives) — MPCO P1
} as const;

export type FeatureBitmask = number;

/**
 * Single source of truth used by STAGE 2 (OI-4 enforcement) and STAGE 4
 * (router → lowerer dispatch).
 *
 * Routing rule (matches D2 table exactly):
 *   - any FOR_EACH bit              → 'pipeline'
 *   - any RUNTIME_LEAF bit          → 'planning-dag' (W3 Slice A)
 *   - any BRANCH | PARALLEL | SUSPEND bit → 'workflow-builder'
 *   - otherwise                     → 'skill-chain'
 */
export function routeTarget(ast: FlowNode): {
  target: CompilationTarget;
  bitmask: FeatureBitmask;
  reason?: "RUNTIME_LEAF_PRESENT";
} {
  const bitmask = computeFeatureBitmask(ast);
  if ((bitmask & FEATURE_BITS.FOR_EACH) !== 0) {
    return { target: "pipeline", bitmask };
  }
  if ((bitmask & FEATURE_BITS.RUNTIME_LEAF) !== 0) {
    return {
      target: "planning-dag",
      bitmask,
      reason: "RUNTIME_LEAF_PRESENT",
    };
  }
  if (
    (bitmask &
      (FEATURE_BITS.BRANCH | FEATURE_BITS.PARALLEL | FEATURE_BITS.SUSPEND)) !==
    0
  ) {
    return { target: "workflow-builder", bitmask };
  }
  return { target: "skill-chain", bitmask };
}

/**
 * Single recursive walk that OR-s feature bits as it descends every body
 * slot of every node type. Pure — no IO, no allocations beyond the bitmask
 * accumulator.
 */
export function computeFeatureBitmask(ast: FlowNode): FeatureBitmask {
  let bits: FeatureBitmask = FEATURE_BITS.SEQUENTIAL_ONLY;

  const visit = (node: FlowNode): void => {
    switch (node.type) {
      case "sequence": {
        for (const child of node.nodes) visit(child);
        return;
      }
      case "action":
      case "complete": {
        // Leaf nodes contribute no bits.
        return;
      }
      case "branch": {
        bits |= FEATURE_BITS.BRANCH;
        for (const child of node.then) visit(child);
        if (node.else) {
          for (const child of node.else) visit(child);
        }
        return;
      }
      case "parallel": {
        bits |= FEATURE_BITS.PARALLEL;
        for (const branch of node.branches) {
          for (const child of branch) visit(child);
        }
        return;
      }
      case "for_each": {
        bits |= FEATURE_BITS.FOR_EACH;
        for (const child of node.body) visit(child);
        return;
      }
      case "approval": {
        bits |= FEATURE_BITS.SUSPEND;
        for (const child of node.onApprove) visit(child);
        if (node.onReject) {
          for (const child of node.onReject) visit(child);
        }
        return;
      }
      case "clarification": {
        bits |= FEATURE_BITS.SUSPEND;
        return;
      }
      case "persona": {
        bits |= FEATURE_BITS.SUSPEND;
        for (const child of node.body) visit(child);
        return;
      }
      case "route": {
        bits |= FEATURE_BITS.SUSPEND;
        for (const child of node.body) visit(child);
        return;
      }
      case "spawn":
      case "classify":
      case "emit":
      case "memory":
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
        // Non-runtime leaf nodes — contribute no feature bits (unchanged).
        return;
      case "worker.dispatch":
      case "set":
      case "return_to":
      case "shell.run":
      case "evidence.write":
      case "validate.schema":
      case "adapter.run":
      case "adapter.race":
      case "adapter.parallel":
      case "adapter.supervisor":
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
      case "spdd.agent_swarm": {
        // Runtime-executed leaf nodes — MPCO P1 marks them so routing keeps
        // them off the skill-chain target (which rejects them at lowering).
        bits |= FEATURE_BITS.RUNTIME_LEAF;
        return;
      }
      case "try_catch": {
        bits |= FEATURE_BITS.BRANCH;
        for (const child of node.body) visit(child);
        for (const child of node.catch) visit(child);
        return;
      }
      case "loop": {
        bits |= FEATURE_BITS.FOR_EACH;
        for (const child of node.body) visit(child);
        return;
      }
      case "prompt":
        bits |= FEATURE_BITS.RUNTIME_LEAF;
        return;
      case "agent":
      case "validate":
        bits |= FEATURE_BITS.RUNTIME_LEAF;
        return;
      default: {
        // Exhaustiveness guard — if a new FlowNode variant is added without
        // a corresponding case, TS will fail compilation here.
        const _exhaustive: never = node;
        void _exhaustive;
        return;
      }
    }
  };

  visit(ast);
  return bits;
}
