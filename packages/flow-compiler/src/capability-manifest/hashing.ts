import { createHash } from "node:crypto";

import type { FlowNode } from "@dzupagent/flow-ast";

export function semanticHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

export function stableStringify(
  value: unknown,
  seen = new WeakSet<object>()
): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value === "symbol") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (seen.has(value)) return JSON.stringify("[Circular]");

  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`
    );
  return `{${entries.join(",")}}`;
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
