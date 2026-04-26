/**
 * JSON-RPC 2.0 endpoint: POST /a2a
 */
import type { Hono } from 'hono'
import {
  JSON_RPC_ERRORS,
  createJsonRpcError,
  validateJsonRpcRequest,
  validateJsonRpcBatch,
} from '@dzupagent/core'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
} from '@dzupagent/core'
import type { A2ARoutesConfig, A2ACallerScope } from './helpers.js'
import { A2A_METHODS, getCallerScope } from './helpers.js'
import {
  handleTasksSend,
  handleTasksGet,
  handleTasksCancel,
  handlePushNotificationSet,
  handlePushNotificationGet,
} from './jsonrpc-handlers.js'

// ---------------------------------------------------------------------------
// JSON-RPC method dispatcher
//
// RF-SEC-05: every dispatched handler receives the authenticated caller's
// scope (extracted once per HTTP request and shared across batch entries) so
// JSON-RPC tasks/* methods enforce the same owner/tenant gating as the REST
// task routes.
// ---------------------------------------------------------------------------

async function handleJsonRpcMethod(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
  scope: A2ACallerScope,
): Promise<JsonRpcResponse> {
  if (!A2A_METHODS.has(req.method)) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`)
  }

  try {
    switch (req.method) {
      case 'tasks/send':
        return await handleTasksSend(req, config, scope)
      case 'tasks/get':
        return await handleTasksGet(req, config, scope)
      case 'tasks/cancel':
        return await handleTasksCancel(req, config, scope)
      case 'tasks/sendSubscribe':
        // SSE streaming is handled at the HTTP level; for JSON-RPC we
        // create the task and return it (client should use SSE endpoint
        // for streaming). This allows basic compatibility.
        return await handleTasksSend(req, config, scope)
      case 'tasks/pushNotification/set':
        return await handlePushNotificationSet(req, config, scope)
      case 'tasks/pushNotification/get':
        return await handlePushNotificationGet(req, config, scope)
      case 'tasks/resubscribe':
        // Resubscribe returns the current task state; actual SSE
        // streaming is a transport-level concern.
        return await handleTasksGet(req, config, scope)
      default:
        return createJsonRpcError(req.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INTERNAL_ERROR, message)
  }
}

export function registerJsonRpcRoute(app: Hono, config: A2ARoutesConfig): void {
  app.post('/a2a', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        createJsonRpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Invalid JSON'),
      )
    }

    // RF-SEC-05: read caller scope once per HTTP request and reuse it for
    // every entry in a JSON-RPC batch.
    const scope = getCallerScope(c)

    // --- Batch request ---
    if (Array.isArray(body)) {
      const batchResult = validateJsonRpcBatch(body)
      if (!batchResult.valid) {
        return c.json(batchResult.error)
      }

      const responses: JsonRpcResponse[] = []
      for (const req of batchResult.requests) {
        const resp = await handleJsonRpcMethod(req, config, scope)
        responses.push(resp)
      }
      return c.json(responses)
    }

    // --- Single request ---
    const validation = validateJsonRpcRequest(body)
    if (!validation.valid) {
      return c.json(validation.error)
    }

    const response = await handleJsonRpcMethod(validation.request, config, scope)
    return c.json(response)
  })
}
