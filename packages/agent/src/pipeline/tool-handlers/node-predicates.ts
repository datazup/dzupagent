import type { PipelineNode, ToolNode } from "@dzupagent/core/pipeline";

import { RUNTIME_TOOL_NAMES, RUNTIME_TOOL_PREFIX } from "./constants.js";

export function isRuntimeToolNode(node: unknown): node is ToolNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    node.type === "tool" &&
    "toolName" in node &&
    typeof node.toolName === "string" &&
    node.toolName.startsWith(RUNTIME_TOOL_PREFIX)
  );
}

export function isRuntimeSetNode(node: PipelineNode): boolean {
  return node.type === "tool" && node.toolName === RUNTIME_TOOL_NAMES.set;
}
