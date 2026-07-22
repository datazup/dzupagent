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
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      return;
    case "sequence":
      for (const child of node.nodes) formatNode(lines, child, indentLevel);
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
      if (node.maxIterations !== undefined)
        lines.push(`${childIndent}max_iterations: ${node.maxIterations}`);
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
