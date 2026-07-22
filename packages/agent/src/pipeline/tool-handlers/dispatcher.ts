import type { ToolNode } from "@dzupagent/core/pipeline";

import type {
  NodeExecutionContext,
  NodeExecutor,
  NodeResult,
  ProviderSessionRef,
  RuntimeToolHandlerFailureResult,
  RuntimeToolHandlers,
  RuntimeToolHandlerSuccessResult,
} from "../pipeline-runtime-types.js";
import {
  compactRuntimeToolResult,
  errorMessage,
  isRecord,
} from "./arg-helpers.js";
import { RUNTIME_TOOL_NAMES, RUNTIME_TOOL_RESULT_MARKER } from "./constants.js";
import { isRuntimeSetNode, isRuntimeToolNode } from "./node-predicates.js";
import { runtimeToolErrorMetadata } from "./results.js";

export function createRuntimeToolNodeExecutor(
  fallbackExecutor: NodeExecutor,
  handlers: RuntimeToolHandlers | undefined
): NodeExecutor {
  return async (nodeId, node, context) => {
    if (isRuntimeSetNode(node)) {
      return executeRuntimeSetNode(nodeId, node as ToolNode, context);
    }

    if (handlers === undefined) return fallbackExecutor(nodeId, node, context);

    if (!isRuntimeToolNode(node)) {
      return fallbackExecutor(nodeId, node, context);
    }

    const startTime = Date.now();
    const handler = handlers[node.toolName];
    if (handler === undefined) {
      return runtimeToolError(
        nodeId,
        startTime,
        `No runtime tool handler registered for "${node.toolName}"`
      );
    }

    try {
      const handlerResult = await handler({
        nodeId,
        node,
        arguments: node.arguments ?? {},
        context,
      });
      return nodeResultFromRuntimeToolResult(nodeId, startTime, handlerResult);
    } catch (error) {
      return runtimeToolError(nodeId, startTime, errorMessage(error));
    }
  };
}

function executeRuntimeSetNode(
  nodeId: string,
  node: ToolNode,
  context: NodeExecutionContext
): NodeResult {
  const startTime = Date.now();
  const assign = node.arguments?.["assign"];
  if (!isRecord(assign)) {
    return runtimeToolError(
      nodeId,
      startTime,
      `${RUNTIME_TOOL_NAMES.set}.assign must be an object`
    );
  }

  const assigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(assign)) {
    const resolved = resolveRuntimeSetValue(value, context);
    context.state[key] = resolved;
    assigned[key] = resolved;
  }

  return {
    nodeId,
    output: assigned,
    durationMs: Date.now() - startTime,
  };
}

function resolveRuntimeSetValue(
  value: unknown,
  context: NodeExecutionContext
): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exact) return resolveRuntimeSetExpression(exact[1]!, context);
    return value.replace(
      /\{\{\s*([^}]+?)\s*\}\}/g,
      (_match, expression: string) =>
        String(resolveRuntimeSetExpression(expression, context) ?? "")
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveRuntimeSetValue(item, context));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        resolveRuntimeSetValue(nested, context),
      ])
    );
  }

  return value;
}

function resolveRuntimeSetExpression(
  expression: string,
  context: NodeExecutionContext
): unknown {
  const trimmed = expression.trim();
  if (trimmed.startsWith("state.")) {
    return readRuntimePath(context.state, trimmed.slice("state.".length));
  }
  return context.state[trimmed];
}

function readRuntimePath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;
    return current[segment];
  }, source);
}

function nodeResultFromRuntimeToolResult(
  nodeId: string,
  startTime: number,
  handlerResult: unknown
): NodeResult {
  if (!isRuntimeToolHandlerResult(handlerResult)) {
    return {
      nodeId,
      output: handlerResult,
      durationMs: Date.now() - startTime,
    };
  }

  if (handlerResult.ok) {
    return compactRuntimeToolResult({
      nodeId,
      output: handlerResult.output,
      durationMs: Date.now() - startTime,
      providerSessionRefs: handlerResult.providerSessionRefs,
    }) as NodeResult;
  }

  return runtimeToolError(
    nodeId,
    startTime,
    handlerResult.error.message,
    runtimeToolErrorMetadata(handlerResult.error),
    handlerResult.providerSessionRefs,
    handlerResult.output
  );
}

function isRuntimeToolHandlerResult(
  value: unknown
): value is RuntimeToolHandlerSuccessResult | RuntimeToolHandlerFailureResult {
  return (
    typeof value === "object" &&
    value !== null &&
    RUNTIME_TOOL_RESULT_MARKER in value &&
    (value as Record<string, unknown>)[RUNTIME_TOOL_RESULT_MARKER] === true &&
    "ok" in value &&
    typeof (value as Record<string, unknown>)["ok"] === "boolean"
  );
}

function runtimeToolError(
  nodeId: string,
  startTime: number,
  error: string,
  errorMetadata?: Record<string, unknown>,
  providerSessionRefs?: ProviderSessionRef[],
  output?: unknown
): NodeResult {
  return compactRuntimeToolResult({
    nodeId,
    output,
    durationMs: Date.now() - startTime,
    error,
    errorMetadata,
    providerSessionRefs,
  }) as NodeResult;
}
