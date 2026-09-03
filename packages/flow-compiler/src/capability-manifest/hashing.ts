import { canonicalDigestPrefixed, canonicalize } from "@dzupagent/canonical-json";

import type { FlowNode } from "@dzupagent/flow-ast";

// Both delegate to @dzupagent/canonical-json's compile-evidence-v1 preset —
// the local copy this file used to carry was byte-for-byte the same
// implementation as the compile-orchestrator/evidence.ts original that
// preset was golden-pinned against (total: bigints as decimal strings,
// function/symbol placeholders, undefined tokens, and a never-unwound
// seen-set rendering every repeated reference as "[Circular]").
export function semanticHash(value: unknown): string {
  return canonicalDigestPrefixed(value, "compile-evidence-v1");
}

export function stableStringify(value: unknown): string {
  return canonicalize(value, "compile-evidence-v1");
}

export function visitFlow(
  node: FlowNode,
  visit: (node: FlowNode) => void
): void {
  visit(node);
  switch (node.type) {
    case "sequence":
      node.nodes.forEach((child) => visitFlow(child, visit));
      return;
    case "for_each":
    case "persona":
    case "route":
    case "try_catch":
    case "loop":
      node.body.forEach((child) => visitFlow(child, visit));
      if (node.type === "try_catch") {
        node.catch.forEach((child) => visitFlow(child, visit));
      }
      return;
    case "branch":
      node.then.forEach((child) => visitFlow(child, visit));
      node.else?.forEach((child) => visitFlow(child, visit));
      return;
    case "parallel":
      node.branches.forEach((branch) =>
        branch.forEach((child) => visitFlow(child, visit))
      );
      return;
    case "approval":
      node.onApprove.forEach((child) => visitFlow(child, visit));
      node.onReject?.forEach((child) => visitFlow(child, visit));
      return;
    default:
      return;
  }
}
