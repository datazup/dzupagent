import type { FlowNode } from "@dzupagent/flow-ast";

import type { CompilationTarget } from "../types.js";

export interface UnsupportedRuntimeNode {
  type: FlowNode["type"];
  path: string;
}

// Runtime-executed leaves can be carried inside richer pipeline artifacts, but
// a flow made only from these leaves would emit an empty generic artifact.
const RUNTIME_LEAF_NODE_TYPES = new Set<FlowNode["type"]>([
  "agent",
  "validate",
  "set",
  "return_to",
  "adapter.run",
  "adapter.race",
  "adapter.parallel",
  "adapter.supervisor",
  "spdd.import_sources",
  "spdd.build_source_pack",
  "spdd.run_analysis",
  "spdd.generate_canvas",
  "spdd.validate_canvas",
  "spdd.review_canvas",
  "spdd.project_plan",
  "spdd.arm_dispatch",
  "spdd.run_validation",
  "spdd.collect_proof",
  "spdd.scan_drift",
  "spdd.create_sync_proposal",
  "spdd.agent_swarm",
  "prompt",
  "worker.dispatch",
  "shell.run",
  "evidence.write",
  "validate.schema",
]);

function isUnsupportedForTarget(
  nodeType: FlowNode["type"],
  target: CompilationTarget,
  hasArtifactAnchor: boolean
): boolean {
  if (!RUNTIME_LEAF_NODE_TYPES.has(nodeType)) return false;
  if (target === "skill-chain") return true;
  if (target === "planning-dag") return false;
  if (!hasArtifactAnchor) return true;
  return false;
}

export function collectUnsupportedRuntimeNodes(
  ast: FlowNode,
  target: CompilationTarget
): UnsupportedRuntimeNode[] {
  const unsupported: UnsupportedRuntimeNode[] = [];
  const hasArtifactAnchor = hasGenericArtifactAnchor(ast, target);

  const visit = (node: FlowNode, path: string): void => {
    if (isUnsupportedForTarget(node.type, target, hasArtifactAnchor)) {
      unsupported.push({ type: node.type, path });
    }

    switch (node.type) {
      case "sequence": {
        node.nodes.forEach((child, idx) =>
          visit(child, `${path}.nodes[${idx}]`)
        );
        return;
      }
      case "branch": {
        node.then.forEach((child, idx) => visit(child, `${path}.then[${idx}]`));
        if (node.else) {
          node.else.forEach((child, idx) =>
            visit(child, `${path}.else[${idx}]`)
          );
        }
        return;
      }
      case "parallel": {
        node.branches.forEach((branch, bIdx) => {
          branch.forEach((child, idx) =>
            visit(child, `${path}.branches[${bIdx}][${idx}]`)
          );
        });
        return;
      }
      case "for_each": {
        node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
        return;
      }
      case "approval": {
        node.onApprove.forEach((child, idx) =>
          visit(child, `${path}.onApprove[${idx}]`)
        );
        if (node.onReject) {
          node.onReject.forEach((child, idx) =>
            visit(child, `${path}.onReject[${idx}]`)
          );
        }
        return;
      }
      case "persona":
      case "route": {
        node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
        return;
      }
      case "try_catch": {
        node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
        node.catch.forEach((child, idx) =>
          visit(child, `${path}.catch[${idx}]`)
        );
        return;
      }
      case "loop": {
        node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
        return;
      }
      case "action":
      case "clarification":
      case "complete":
      case "spawn":
      case "classify":
      case "emit":
      case "memory":
      case "checkpoint":
      case "restore":
      case "http":
      case "wait":
      case "subflow":
      case "prompt":
      case "return_to":
      case "agent":
      case "validate":
      case "set":
      case "fleet.dispatch":
      case "fleet.gather":
      case "fleet.contract-net":
      case "knowledge.write":
      case "knowledge.query":
      case "worker.dispatch":
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
      case "spdd.agent_swarm":
        return;
      default: {
        const _exhaustive: never = node;
        void _exhaustive;
        return;
      }
    }
  };

  visit(ast, "root");
  return unsupported;
}

function hasGenericArtifactAnchor(
  ast: FlowNode,
  target: CompilationTarget
): boolean {
  const visit = (node: FlowNode): boolean => {
    switch (node.type) {
      case "action":
      case "clarification":
      case "complete":
        return true;
      case "for_each":
        return target === "pipeline";
      case "branch":
        return (
          node.then.some(visit) ||
          (node.else !== undefined && node.else.some(visit))
        );
      case "parallel":
        return node.branches.some((branch) => branch.some(visit));
      case "approval":
        return (
          node.onApprove.some(visit) ||
          (node.onReject !== undefined && node.onReject.some(visit))
        );
      case "persona":
      case "route":
        return node.body.some(visit);
      case "sequence":
        return node.nodes.some(visit);
      case "try_catch":
        return node.body.some(visit) || node.catch.some(visit);
      case "loop":
        return target === "pipeline" || node.body.some(visit);
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
        return false;
      case "prompt":
      case "agent":
      case "validate":
      case "set":
      case "return_to":
      case "worker.dispatch":
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
      case "spdd.agent_swarm":
        return target === "planning-dag";
      default: {
        const _exhaustive: never = node;
        void _exhaustive;
        return false;
      }
    }
  };

  return visit(ast);
}
