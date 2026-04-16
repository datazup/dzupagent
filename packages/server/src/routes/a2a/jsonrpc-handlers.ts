/**
 * JSON-RPC 2.0 method handlers for A2A protocol.
 */
import type { A2ATaskState, A2ATaskMessage } from '../../a2a/task-handler.js'
import {
  JSON_RPC_ERRORS,
  A2A_ERRORS,
  createJsonRpcError,
  createJsonRpcSuccess,
} from '@dzupagent/core'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
} from '@dzupagent/core'
import type { A2ARoutesConfig } from './helpers.js'

// ---------------------------------------------------------------------------
// tasks/send — create or continue a task
// ---------------------------------------------------------------------------

export async function handleTasksSend(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
): Promise<JsonRpcResponse> {
  const params = req.params
  if (!params) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing params')
  }

  const taskId = params['id'] as string | undefined
  const message = params['message'] as A2ATaskMessage | undefined

  if (!message || typeof message !== 'object' || !message.role || !Array.isArray(message.parts)) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.message is required and must have role and parts')
  }

  // --- Multi-turn: continue existing task ---
  if (taskId) {
    const existing = await config.taskStore.get(taskId)
    if (existing) {
      // Only tasks in input-required state can accept more input
      if (existing.state === 'input-required') {
        const updated = await config.taskStore.appendMessage(taskId, message)
        if (!updated) {
          return createJsonRpcError(req.id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`)
        }

        // Transition back to working
        const continued = await config.taskStore.update(taskId, { state: 'working' })

        if (config.onTaskContinued && continued) {
          config.onTaskContinued(continued).catch(() => {
            void config.taskStore.update(taskId, {
              state: 'failed',
              error: 'Task continuation callback failed',
            })
          })
        }

        return createJsonRpcSuccess(req.id, continued)
      }

      // Task exists but is not in input-required state — error
      const terminal: A2ATaskState[] = ['completed', 'failed', 'cancelled']
      if (terminal.includes(existing.state)) {
        return createJsonRpcError(
          req.id,
          A2A_ERRORS.TASK_NOT_CANCELABLE,
          `Task ${taskId} is in terminal state: ${existing.state}`,
        )
      }

      // Task is still working/submitted — append message anyway
      const updated = await config.taskStore.appendMessage(taskId, message)
      return createJsonRpcSuccess(req.id, updated)
    }
  }

  // --- New task ---
  // Extract agentName from metadata or params
  const agentName = (params['agentName'] as string | undefined)
    ?? (params['metadata'] as Record<string, unknown> | undefined)?.['agentName'] as string | undefined

  // If no agentName, use the first capability on the card
  const resolvedAgentName = agentName ?? config.agentCard.capabilities[0]?.name ?? 'default'

  // Build text input from message parts for backward compat
  const textParts = message.parts
    .filter((p): p is { type: string; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
  const inputText = textParts.join('\n') || JSON.stringify(message.parts)

  const task = await config.taskStore.create({
    agentName: resolvedAgentName,
    input: inputText,
    state: 'submitted',
    metadata: params['metadata'] as Record<string, unknown> | undefined,
  })

  // Store the initial message
  await config.taskStore.appendMessage(task.id, message)

  if (config.onTaskSubmitted) {
    config.onTaskSubmitted(task).catch(() => {
      void config.taskStore.update(task.id, {
        state: 'failed',
        error: 'Task execution callback failed',
      })
    })
  }

  return createJsonRpcSuccess(req.id, task)
}

// ---------------------------------------------------------------------------
// tasks/get
// ---------------------------------------------------------------------------

export async function handleTasksGet(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
): Promise<JsonRpcResponse> {
  const taskId = req.params?.['id'] as string | undefined
  if (!taskId) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.id is required')
  }

  const task = await config.taskStore.get(taskId)
  if (!task) {
    return createJsonRpcError(req.id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`)
  }

  return createJsonRpcSuccess(req.id, task)
}

// ---------------------------------------------------------------------------
// tasks/cancel
// ---------------------------------------------------------------------------

export async function handleTasksCancel(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
): Promise<JsonRpcResponse> {
  const taskId = req.params?.['id'] as string | undefined
  if (!taskId) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.id is required')
  }

  const task = await config.taskStore.get(taskId)
  if (!task) {
    return createJsonRpcError(req.id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`)
  }

  const terminal: A2ATaskState[] = ['completed', 'failed', 'cancelled']
  if (terminal.includes(task.state)) {
    return createJsonRpcError(
      req.id,
      A2A_ERRORS.TASK_NOT_CANCELABLE,
      `Task ${taskId} already in terminal state: ${task.state}`,
    )
  }

  const updated = await config.taskStore.update(task.id, { state: 'cancelled' })
  return createJsonRpcSuccess(req.id, updated)
}

// ---------------------------------------------------------------------------
// tasks/pushNotification/set
// ---------------------------------------------------------------------------

export async function handlePushNotificationSet(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
): Promise<JsonRpcResponse> {
  const taskId = req.params?.['id'] as string | undefined
  if (!taskId) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.id is required')
  }

  const pushConfig = req.params?.['pushNotificationConfig'] as { url: string; token?: string; events?: string[] } | undefined
  if (!pushConfig || typeof pushConfig.url !== 'string') {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.pushNotificationConfig.url is required')
  }

  const task = await config.taskStore.get(taskId)
  if (!task) {
    return createJsonRpcError(req.id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`)
  }

  const updated = await config.taskStore.setPushConfig(taskId, pushConfig)
  return createJsonRpcSuccess(req.id, updated)
}

// ---------------------------------------------------------------------------
// tasks/pushNotification/get
// ---------------------------------------------------------------------------

export async function handlePushNotificationGet(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
): Promise<JsonRpcResponse> {
  const taskId = req.params?.['id'] as string | undefined
  if (!taskId) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.id is required')
  }

  const task = await config.taskStore.get(taskId)
  if (!task) {
    return createJsonRpcError(req.id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`)
  }

  return createJsonRpcSuccess(req.id, task.pushNotificationConfig ?? null)
}
