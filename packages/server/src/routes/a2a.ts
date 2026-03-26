/**
 * A2A protocol routes.
 *
 * REST endpoints (backward-compatible):
 * - `GET  /.well-known/agent.json` — Agent card discovery
 * - `POST /a2a/tasks`              — Submit a new task
 * - `GET  /a2a/tasks/:id`          — Poll task status / result
 * - `GET  /a2a/tasks`              — List tasks (filter by agentName, state)
 * - `POST /a2a/tasks/:id/cancel`   — Cancel a running task
 *
 * JSON-RPC 2.0 endpoint:
 * - `POST /a2a`                    — JSON-RPC 2.0 (single + batch)
 */
import { Hono } from 'hono'
import type { AgentCard } from '../a2a/agent-card.js'
import type { A2ATask, A2ATaskState, A2ATaskStore, A2ATaskMessage } from '../a2a/task-handler.js'
import {
  JSON_RPC_ERRORS,
  A2A_ERRORS,
  createJsonRpcError,
  createJsonRpcSuccess,
  validateJsonRpcRequest,
  validateJsonRpcBatch,
} from '@forgeagent/core'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
} from '@forgeagent/core'

export interface A2ARoutesConfig {
  agentCard: AgentCard
  taskStore: A2ATaskStore
  /** Called after a task is created so the host can start execution. */
  onTaskSubmitted?: (task: A2ATask) => Promise<void>
  /** Called when a multi-turn task receives additional input. */
  onTaskContinued?: (task: A2ATask) => Promise<void>
}

/** Known A2A JSON-RPC methods. */
const A2A_METHODS = new Set([
  'tasks/send',
  'tasks/get',
  'tasks/cancel',
  'tasks/sendSubscribe',
  'tasks/pushNotification/set',
  'tasks/pushNotification/get',
  'tasks/resubscribe',
])

export function createA2ARoutes(config: A2ARoutesConfig): Hono {
  const app = new Hono()

  // =========================================================================
  // JSON-RPC 2.0 endpoint
  // =========================================================================

  app.post('/a2a', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        createJsonRpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Invalid JSON'),
      )
    }

    // --- Batch request ---
    if (Array.isArray(body)) {
      const batchResult = validateJsonRpcBatch(body)
      if (!batchResult.valid) {
        return c.json(batchResult.error)
      }

      const responses: JsonRpcResponse[] = []
      for (const req of batchResult.requests) {
        const resp = await handleJsonRpcMethod(req, config)
        responses.push(resp)
      }
      return c.json(responses)
    }

    // --- Single request ---
    const validation = validateJsonRpcRequest(body)
    if (!validation.valid) {
      return c.json(validation.error)
    }

    const response = await handleJsonRpcMethod(validation.request, config)
    return c.json(response)
  })

  // =========================================================================
  // REST endpoints (backward-compatible)
  // =========================================================================

  // --- Agent card discovery ---
  app.get('/.well-known/agent.json', (c) => {
    return c.json(config.agentCard)
  })

  // --- Submit task ---
  app.post('/a2a/tasks', async (c) => {
    const body = await c.req.json<{
      agentName: string
      input: unknown
      metadata?: Record<string, unknown>
    }>()

    if (!body.agentName || body.input === undefined) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'agentName and input are required' } },
        400,
      )
    }

    // Verify the agent name is in the card's capabilities
    const known = config.agentCard.capabilities.some((cap) => cap.name === body.agentName)
    if (!known) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Unknown agent: ${body.agentName}` } },
        404,
      )
    }

    const task = await config.taskStore.create({
      agentName: body.agentName,
      input: body.input,
      state: 'submitted',
      metadata: body.metadata,
    })

    if (config.onTaskSubmitted) {
      // Fire-and-forget — caller polls for result
      config.onTaskSubmitted(task).catch(() => {
        void config.taskStore.update(task.id, {
          state: 'failed',
          error: 'Task execution callback failed',
        })
      })
    }

    return c.json(task, 201)
  })

  // --- Get task ---
  app.get('/a2a/tasks/:id', async (c) => {
    const task = await config.taskStore.get(c.req.param('id'))
    if (!task) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Task not found' } },
        404,
      )
    }
    return c.json(task)
  })

  // --- List tasks ---
  app.get('/a2a/tasks', async (c) => {
    const agentName = c.req.query('agentName')
    const state = c.req.query('state') as A2ATaskState | undefined
    const tasks = await config.taskStore.list({
      agentName: agentName ?? undefined,
      state: state ?? undefined,
    })
    return c.json({ tasks })
  })

  // --- Cancel task ---
  app.post('/a2a/tasks/:id/cancel', async (c) => {
    const task = await config.taskStore.get(c.req.param('id'))
    if (!task) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Task not found' } },
        404,
      )
    }

    const terminal: A2ATaskState[] = ['completed', 'failed', 'cancelled']
    if (terminal.includes(task.state)) {
      return c.json(
        { error: { code: 'CONFLICT', message: `Task already in terminal state: ${task.state}` } },
        409,
      )
    }

    const updated = await config.taskStore.update(task.id, { state: 'cancelled' })
    return c.json(updated)
  })

  return app
}

// ---------------------------------------------------------------------------
// JSON-RPC method dispatcher
// ---------------------------------------------------------------------------

async function handleJsonRpcMethod(
  req: JsonRpcRequest,
  config: A2ARoutesConfig,
): Promise<JsonRpcResponse> {
  if (!A2A_METHODS.has(req.method)) {
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`)
  }

  try {
    switch (req.method) {
      case 'tasks/send':
        return await handleTasksSend(req, config)
      case 'tasks/get':
        return await handleTasksGet(req, config)
      case 'tasks/cancel':
        return await handleTasksCancel(req, config)
      case 'tasks/sendSubscribe':
        // SSE streaming is handled at the HTTP level; for JSON-RPC we
        // create the task and return it (client should use SSE endpoint
        // for streaming). This allows basic compatibility.
        return await handleTasksSend(req, config)
      case 'tasks/pushNotification/set':
        return await handlePushNotificationSet(req, config)
      case 'tasks/pushNotification/get':
        return await handlePushNotificationGet(req, config)
      case 'tasks/resubscribe':
        // Resubscribe returns the current task state; actual SSE
        // streaming is a transport-level concern.
        return await handleTasksGet(req, config)
      default:
        return createJsonRpcError(req.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return createJsonRpcError(req.id, JSON_RPC_ERRORS.INTERNAL_ERROR, message)
  }
}

// ---------------------------------------------------------------------------
// tasks/send — create or continue a task
// ---------------------------------------------------------------------------

async function handleTasksSend(
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

async function handleTasksGet(
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

async function handleTasksCancel(
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

async function handlePushNotificationSet(
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

async function handlePushNotificationGet(
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
