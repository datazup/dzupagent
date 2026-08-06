import {
  formatScalar,
  indentFor,
  pushCommon,
  quote,
  type FormatContext,
  type NodeOf,
} from "./format-helpers.js";

/** Control-flow and structural node categories (recursion, branching, loops). */
export function formatStructuralNode(
  ctx: FormatContext,
  node: NodeOf<
    | "action"
    | "branch"
    | "parallel"
    | "for_each"
    | "sequence"
    | "loop"
    | "try_catch"
    | "wait"
    | "return_to"
  >,
  indentLevel: number
): void {
  const { lines, formatNode } = ctx;
  const indent = indentFor(indentLevel);
  const childIndent = indentFor(indentLevel + 2);
  switch (node.type) {
    case "action":
      lines.push(`${indent}- action:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}ref: ${node.toolRef}`);
      if (node.personaRef)
        lines.push(`${childIndent}persona: ${node.personaRef}`);
      lines.push(`${childIndent}input:`);
      for (const [key, value] of Object.entries(node.input)) {
        lines.push(`${childIndent}  ${key}: ${formatScalar(value)}`);
      }
      return;
    case "branch":
      lines.push(`${indent}- if:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}condition: ${quote(node.condition)}`);
      if (node.typedCondition !== undefined) {
        lines.push(
          `${childIndent}typedCondition: ${formatScalar(node.typedCondition)}`
        );
      }
      lines.push(`${childIndent}then:`);
      for (const child of node.then) formatNode(lines, child, indentLevel + 3);
      if (node.else && node.else.length > 0) {
        lines.push(`${childIndent}else:`);
        for (const child of node.else)
          formatNode(lines, child, indentLevel + 3);
      }
      return;
    case "parallel": {
      lines.push(`${indent}- parallel:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}branches:`);
      const branchNames = Array.isArray(node.meta?.["branchNames"])
        ? node.meta!["branchNames"].filter(
            (value): value is string => typeof value === "string"
          )
        : [];
      node.branches.forEach((branch, index) => {
        const name = branchNames[index] ?? `branch_${index + 1}`;
        lines.push(`${childIndent}  ${name}:`);
        for (const child of branch) formatNode(lines, child, indentLevel + 4);
      });
      return;
    }
    case "for_each":
      lines.push(`${indent}- for_each:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}source: ${quote(node.source)}`);
      lines.push(`${childIndent}as: ${node.as}`);
      if (node.attachAs !== undefined)
        lines.push(`${childIndent}attachAs: ${quote(node.attachAs)}`);
      if (node.collect !== undefined) {
        lines.push(`${childIndent}collect:`);
        lines.push(`${childIndent}  from: ${quote(node.collect.from)}`);
        lines.push(`${childIndent}  into: ${quote(node.collect.into)}`);
      }
      if (node.accumulator !== undefined) {
        lines.push(`${childIndent}accumulator:`);
        lines.push(`${childIndent}  key: ${quote(node.accumulator.key)}`);
        if (node.accumulator.window !== undefined)
          lines.push(`${childIndent}  window: ${node.accumulator.window}`);
        if (node.accumulator.initialValue !== undefined)
          lines.push(
            `${childIndent}  initialValue: ${formatScalar(
              node.accumulator.initialValue
            )}`
          );
      }
      if (node.concurrency !== undefined)
        lines.push(`${childIndent}concurrency: ${node.concurrency}`);
      if (node.failFast !== undefined)
        lines.push(`${childIndent}failFast: ${String(node.failFast)}`);
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      return;
    case "sequence":
      // The ROOT sequence never reaches here — `formatDocument` writes it as
      // the top-level `steps:` list directly. So any sequence at this point
      // is nested, and must emit its `group:` wrapper rather than splice its
      // children into the parent list (which silently dropped type/id/nodes
      // on every round trip before the `group:` surface existed).
      lines.push(`${indent}- group:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}steps:`);
      for (const child of node.nodes) formatNode(lines, child, indentLevel + 3);
      return;
    case "try_catch":
      lines.push(`${indent}- try_catch:`);
      pushCommon(lines, node, indentLevel + 2);
      if (node.errorVar)
        lines.push(`${childIndent}error_var: ${node.errorVar}`);
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      lines.push(`${childIndent}catch:`);
      for (const child of node.catch) formatNode(lines, child, indentLevel + 3);
      return;
    case "loop":
      lines.push(`${indent}- loop:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}condition: ${quote(node.condition)}`);
      if (node.typedCondition !== undefined) {
        lines.push(
          `${childIndent}typedCondition: ${formatScalar(node.typedCondition)}`
        );
      }
      if (node.maxIterations !== undefined)
        lines.push(`${childIndent}max_iterations: ${node.maxIterations}`);
      if (node.progressKey !== undefined)
        lines.push(`${childIndent}progressKey: ${quote(node.progressKey)}`);
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      return;
    case "wait":
      lines.push(`${indent}- wait:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}durationMs: ${node.durationMs}`);
      return;
    case "return_to":
      lines.push(`${indent}- return_to:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}targetId: ${node.targetId}`);
      lines.push(`${childIndent}condition: ${quote(node.condition)}`);
      if (node.maxIterations !== undefined)
        lines.push(`${childIndent}maxIterations: ${node.maxIterations}`);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}
