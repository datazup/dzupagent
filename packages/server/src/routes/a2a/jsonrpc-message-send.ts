/**
 * A2A v0.3.0 `message/send` (A2A-05-SERVER-V030-20261108-R1): an adapter over
 * `tasks/send`, so the store, owner/tenant scoping and execution callbacks are
 * the existing ones. Never blocks; `configuration` is ignored.
 */
import {
  A2A_ERRORS,
  JSON_RPC_ERRORS,
  createJsonRpcError,
  createJsonRpcSuccess,
} from "@dzupagent/core/identity";
import type { JsonRpcRequest, JsonRpcResponse } from "@dzupagent/core/identity";
import { parseMessageV030, taskToV030 } from "../../a2a/message-v030.js";
import type { A2ACallerScope, A2ARoutesConfig } from "./helpers.js";
import { callerOwnsTask } from "./helpers.js";
import { handleTasksSend } from "./jsonrpc-handlers.js";

export async function handleMessageSend(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
  scope: A2ACallerScope
): Promise<JsonRpcResponse> {
  const params = req.params;
  if (!params) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, "Missing params");
  }
  const parsed = parseMessageV030(params["message"]);
  if (!parsed.ok) {
    return createJsonRpcError(
      req.id,
      parsed.reason === "content" ? A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED : JSON_RPC_ERRORS.INVALID_PARAMS,
      parsed.detail
    );
  }

  // Validate everything the delegate will consume before any store operation.
  const metadata = params["metadata"];
  if (metadata !== undefined) {
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, "params.metadata must be an object");
    }
    const agentName = (metadata as Record<string, unknown>)["agentName"];
    if (agentName !== undefined && (typeof agentName !== "string" || agentName.length === 0)) {
      return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, "metadata.agentName must be a non-empty string");
    }
  }

  const { taskId } = parsed;
  if (taskId !== undefined) {
    // Unknown, or another owner's or tenant's: indistinguishable (existing isolation policy).
    const existing = await config.taskStore.get(taskId);
    if (!existing || !callerOwnsTask(scope, existing)) {
      return createJsonRpcError(req.id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`);
    }
  }

  const delegated = await handleTasksSend(
    {
      ...req,
      params: {
        ...(taskId === undefined ? {} : { id: taskId }),
        message: parsed.message,
        ...(metadata === undefined ? {} : { metadata }),
      },
    },
    config,
    scope
  );
  if ("error" in delegated) return delegated;

  // tasks/send answers with the record from before the message was appended: reread it.
  const id = (delegated.result as { id?: unknown } | null)?.id;
  const task = typeof id === "string" ? await config.taskStore.get(id) : null;
  if (!task) {
    return createJsonRpcError(req.id, A2A_ERRORS.TASK_NOT_FOUND, "Task not found");
  }
  return createJsonRpcSuccess(req.id, taskToV030(task, parsed.contextId));
}
