import type { FlowNode } from "@dzupagent/flow-ast";

/**
 * STAGE 2 (OI-4) and STAGE 4 (defense-in-depth backstop) both need to know
 * whether any node in the AST carries an `on_error` field. The FlowNode
 * union does not yet declare `on_error` as a typed property on any variant
 * (introduced pre-emptively in Wave 10); detection is therefore done via a
 * forward-compatible structural check. When a future wave promotes
 * `on_error` to a typed field, this check stays correct without edits.
 */
export function hasOnError(ast: FlowNode): boolean {
  let found = false;

  const visit = (node: FlowNode): void => {
    if (found) return;
    if ((node as unknown as Record<string, unknown>).on_error !== undefined) {
      found = true;
      return;
    }
    switch (node.type) {
      case "sequence": {
        for (const child of node.nodes) visit(child);
        return;
      }
      case "branch": {
        for (const child of node.then) visit(child);
        if (node.else) {
          for (const child of node.else) visit(child);
        }
        return;
      }
      case "parallel": {
        for (const branch of node.branches) {
          for (const child of branch) visit(child);
        }
        return;
      }
      case "for_each": {
        for (const child of node.body) visit(child);
        return;
      }
      case "approval": {
        for (const child of node.onApprove) visit(child);
        if (node.onReject) {
          for (const child of node.onReject) visit(child);
        }
        return;
      }
      case "persona": {
        for (const child of node.body) visit(child);
        return;
      }
      case "route": {
        for (const child of node.body) visit(child);
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
      case "fleet.dispatch":
      case "fleet.gather":
      case "fleet.contract-net":
      case "knowledge.write":
      case "knowledge.query":
      case "worker.dispatch":
      case "set":
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
        return;
      }
      case "try_catch": {
        for (const child of node.body) visit(child);
        for (const child of node.catch) visit(child);
        return;
      }
      case "loop": {
        for (const child of node.body) visit(child);
        return;
      }
      case "prompt":
      case "return_to":
      case "agent":
      case "validate":
        return;
      default: {
        const _exhaustive: never = node;
        void _exhaustive;
        return;
      }
    }
  };

  visit(ast);
  return found;
}
