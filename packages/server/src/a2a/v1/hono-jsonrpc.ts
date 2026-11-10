import { Extensions, HTTP_EXTENSION_HEADER } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import type { Context } from "hono";
import { createJsonRpcError, validateJsonRpcRequest } from "@dzupagent/core/identity";
import { getCallerScope } from "../../routes/a2a/helpers.js";
import { logRouteError } from "../../routes/route-error.js";
import { getSerializedJsonSizeBytes } from "../../validation/route-validator.js";
import type { AppEnv } from "../../types.js";
import { VerifiedA2AUser } from "./identity.js";
import type { A2AV1Handler } from "./request-handler.js";

const PARAMS_MAX_BYTES = 256 * 1024;
const PUSH_METHODS = new Set([
  "CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig",
]);

/** Fixed client-visible text per JSON-RPC code; SDK messages can echo caller or host text. */
const FIXED_ERROR_MESSAGES = new Map<number, string>([
  [-32700, "Parse error"], [-32600, "Invalid request"], [-32601, "Unknown method"], [-32602, "Invalid method parameters"],
  [-32001, "Task not found"], [-32002, "Task cannot be canceled"], [-32003, "Push notifications are not supported"],
  [-32004, "Operation is not supported"], [-32005, "Content type is not supported"], [-32009, "Version not supported"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Values the SDK decoder would read for an optional field: proto3 JSON treats
 * null as absent, and the SDK also accepts the snake_case alias of each name.
 */
function presentValues(record: Record<string, unknown>, ...names: string[]): unknown[] {
  return names.map((name) => record[name]).filter((value) => value !== undefined && value !== null);
}

/**
 * Optional fields the SDK would otherwise coerce (String(), Number()) or silently
 * drop. Returns false when any present value has the wrong type.
 */
function validOptionalSendFields(message: Record<string, unknown>, configuration: unknown): boolean {
  const ids = presentValues(message, "contextId", "context_id", "taskId", "task_id");
  if (!ids.every((value) => typeof value === "string")) return false;
  if (!presentValues(message, "metadata").every(isRecord)) return false;
  if (!isRecord(configuration)) return true;
  const lengths = presentValues(configuration, "historyLength", "history_length");
  if (!lengths.every((value) => Number.isInteger(value) && (value as number) >= 0)) return false;
  return presentValues(configuration, "acceptedOutputModes", "accepted_output_modes")
    .every((modes) => Array.isArray(modes) && modes.every((mode) => typeof mode === "string"));
}

/** Transport glue only: all task execution, serialization and storage use SDK ports. */
export async function handleA2AV1JsonRpc(c: Context<AppEnv>, v1: A2AV1Handler): Promise<Response> {
  const scope = getCallerScope(c);
  if (!scope.ownerId || !scope.tenantId) {
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(createJsonRpcError(null, -32700, "Invalid JSON"));
  }
  // The existing validator supplies envelope types; arrays are not v1 requests.
  const validation = validateJsonRpcRequest(body);
  if (!validation.valid) return c.json(validation.error);
  const request = validation.request;
  const id = request.id;
  const fail = (code: number, message: string) => c.json(createJsonRpcError(id, code, message));
  if (getSerializedJsonSizeBytes(request.params) > PARAMS_MAX_BYTES) {
    return fail(-32600, "params too large");
  }

  const context = new ServerCallContext({
    user: new VerifiedA2AUser(scope),
    tenant: scope.tenantId,
    requestedVersion: c.req.header("A2A-Version"),
    requestedExtensions: Extensions.parseServiceParameter(c.req.header(HTTP_EXTENSION_HEADER)),
    state: new Map<string, unknown>([["dzup.a2a.route", c]]),
  });
  try {
    validateVersion(context.requestedVersion, v1.card, "JSONRPC");
  } catch (error) {
    const mapped = JsonRpcTransportHandler.mapToJSONRPCError(error);
    if (mapped.code === -32009) return fail(-32009, "Version not supported");
    const { safe } = logRouteError(c, "a2a.v1.version", error);
    return fail(-32603, safe);
  }

  const params = request.params;
  if (!isRecord(params)) return fail(-32602, "Invalid method parameters");
  if (params.tenant !== undefined && params.tenant !== "" && params.tenant !== scope.tenantId) {
    return fail(-32602, "Invalid tenant");
  }
  // Never let the SDK overwrite or re-set the authenticated context's tenant.
  const cleanParams = { ...params };
  delete cleanParams.tenant;
  if (cleanParams.metadata !== undefined && !isRecord(cleanParams.metadata)) {
    return fail(-32602, "Invalid metadata");
  }
  if (cleanParams.historyLength !== undefined &&
      (!Number.isInteger(cleanParams.historyLength) || Number(cleanParams.historyLength) < 0)) {
    return fail(-32602, "Invalid history length");
  }
  // GetTask's decoder also reads the snake_case alias and would Number()-coerce it.
  if (!presentValues(cleanParams, "history_length").every((value) => Number.isInteger(value) && (value as number) >= 0)) {
    return fail(-32602, "Invalid method parameters");
  }
  if (request.method === "SendStreamingMessage" || request.method === "SubscribeToTask") {
    return fail(-32004, "Streaming is not supported");
  }
  if (PUSH_METHODS.has(request.method)) return fail(-32003, "Push notifications are not supported");
  if (!["SendMessage", "GetTask", "CancelTask"].includes(request.method)) {
    return fail(-32601, "Unknown method");
  }
  if (request.method === "SendMessage") {
    const configuration = cleanParams.configuration;
    if (configuration !== undefined && (!isRecord(configuration) ||
        (configuration.returnImmediately !== undefined && typeof configuration.returnImmediately !== "boolean"))) {
      return fail(-32602, "Invalid configuration");
    }
    const message = cleanParams.message;
    if (!isRecord(message) || typeof message.messageId !== "string" || !message.messageId ||
        typeof message.role !== "string" || !["ROLE_USER", "ROLE_AGENT"].includes(message.role) ||
        !Array.isArray(message.parts) || message.parts.length === 0) {
      return fail(-32602, "Invalid message");
    }
    if (!validOptionalSendFields(message, configuration)) return fail(-32602, "Invalid method parameters");
    const parts: Record<string, unknown>[] = [];
    for (const part of message.parts) {
      if (!isRecord(part)) return fail(-32602, "Invalid message part");
      if (part.mediaType !== undefined && typeof part.mediaType !== "string") {
        return fail(-32602, "Invalid media type");
      }
      const fields = ["text", "raw", "url", "data"].filter((key) => Object.hasOwn(part, key));
      if (fields.length !== 1 || (Object.hasOwn(part, "text") && typeof part.text !== "string")) {
        return fail(-32602, "Invalid message part");
      }
      // SDK input-mode validation checks declared media types. Supply a truthful
      // non-text mode even if the caller omitted it or labelled data text/plain.
      parts.push({ ...part, mediaType: Object.hasOwn(part, "text")
        ? (part.mediaType || "text/plain")
        : (part.mediaType && part.mediaType !== "text/plain" ? part.mediaType : "application/octet-stream") });
    }
    cleanParams.message = { ...message, parts };
  } else if (typeof cleanParams.id !== "string" || !cleanParams.id.trim()) {
    return fail(-32602, "Task id is required");
  }

  try {
    const response = await v1.handler.handle({ ...request, params: cleanParams }, context);
    if (Symbol.asyncIterator in response) {
      await response.return(undefined);
      return fail(-32004, "Streaming is not supported");
    }
    if (isRecord(response.error)) {
      const fixed = typeof response.error.code === "number" ? FIXED_ERROR_MESSAGES.get(response.error.code) : undefined;
      if (fixed === undefined || response.error.code === -32603) {
        const { safe } = logRouteError(c, "a2a.v1.jsonrpc", new Error(String(response.error.message)));
        return fail(-32603, safe);
      }
      return fail(response.error.code as number, fixed);
    }
    if (context.activatedExtensions?.length) {
      c.header(HTTP_EXTENSION_HEADER, Extensions.toServiceParameter(context.activatedExtensions));
    }
    return c.json(response);
  } catch (error) {
    const { safe } = logRouteError(c, "a2a.v1.jsonrpc", error);
    return fail(-32603, safe);
  }
}
