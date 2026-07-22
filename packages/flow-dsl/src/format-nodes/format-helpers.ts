import type { FlowNode } from "@dzupagent/flow-ast";

/**
 * Shared context threaded through every node-group formatter.
 *
 * `formatNode` is injected so group formatters can recurse into child nodes
 * without importing the coordinator (which would create a circular import).
 */
export interface FormatContext {
  readonly lines: string[];
  readonly formatNode: (
    lines: string[],
    node: FlowNode,
    indentLevel: number
  ) => void;
}

/** Narrow the `FlowNode` union to the members with the given `type` tag. */
export type NodeOf<T extends FlowNode["type"]> = Extract<FlowNode, { type: T }>;

export function indentFor(indentLevel: number): string {
  return "  ".repeat(indentLevel);
}

export function pushCommon(
  lines: string[],
  node: FlowNode,
  indentLevel: number
): void {
  const indent = indentFor(indentLevel);
  if (node.id) lines.push(`${indent}id: ${node.id}`);
  if (node.name) lines.push(`${indent}name: ${quote(node.name)}`);
  if (node.description)
    lines.push(`${indent}description: ${quote(node.description)}`);
  if (
    node.meta &&
    Object.keys(node.meta).length > 0 &&
    !(node.type === "parallel" && node.meta.branchNames)
  ) {
    lines.push(`${indent}meta:`);
    for (const [key, value] of Object.entries(node.meta)) {
      lines.push(`${indent}  ${key}: ${formatScalar(value)}`);
    }
  }
}

export function pushField(
  lines: string[],
  indentLevel: number,
  key: string,
  value: string | number
): void {
  const indent = indentFor(indentLevel);
  lines.push(
    `${indent}${key}: ${typeof value === "string" ? quote(value) : value}`
  );
}

export function quote(value: string): string {
  if (/^[A-Za-z0-9_.\/:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function formatScalar(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(formatScalar).join(", ")}]`;
  return JSON.stringify(value);
}
