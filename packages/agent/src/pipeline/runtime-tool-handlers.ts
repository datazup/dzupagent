import type { ToolNode } from "@dzupagent/core/pipeline";
import type {
  NodeExecutor,
  NodeResult,
  RuntimeToolHandler,
  RuntimeToolHandlers,
} from "./pipeline-runtime-types.js";

export const RUNTIME_TOOL_PREFIX = "dzup.runtime.";

export function createRuntimeToolNodeExecutor(
  fallbackExecutor: NodeExecutor,
  handlers: RuntimeToolHandlers | undefined,
): NodeExecutor {
  if (handlers === undefined) return fallbackExecutor;

  return async (nodeId, node, context) => {
    if (!isRuntimeToolNode(node)) {
      return fallbackExecutor(nodeId, node, context);
    }

    const startTime = Date.now();
    const handler = handlers[node.toolName];
    if (handler === undefined) {
      return runtimeToolError(
        nodeId,
        startTime,
        `No runtime tool handler registered for "${node.toolName}"`,
      );
    }

    try {
      return {
        nodeId,
        output: await handler({
          nodeId,
          node,
          arguments: node.arguments ?? {},
          context,
        }),
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return runtimeToolError(nodeId, startTime, errorMessage(error));
    }
  };
}

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

function runtimeToolError(
  nodeId: string,
  startTime: number,
  error: string,
): NodeResult {
  return {
    nodeId,
    output: undefined,
    durationMs: Date.now() - startTime,
    error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { RuntimeToolHandler, RuntimeToolHandlers };
