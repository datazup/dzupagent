/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 *
 * Supports both non-streaming (JSON response) and streaming (SSE) modes.
 * The `model` field in the request is resolved to an agent via AgentStore.
 * The agent is instantiated as a DzupAgent and executed with generate() or
 * stream() depending on the `stream` flag.
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HumanMessage } from '@langchain/core/messages'
import { DzupAgent } from '@dzupagent/agent'
import type { AgentStore, ModelRegistry, DzupEventBus } from '@dzupagent/core'
import { OpenAICompletionMapper } from './completion-mapper.js'
import type { ChatCompletionRequest, OpenAIErrorResponse } from './types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CompletionsRouteConfig {
  agentStore: AgentStore
  modelRegistry: ModelRegistry
  eventBus: DzupEventBus
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function errorResponse(
  message: string,
  type: string,
  param: string | null,
  code: string | null,
): OpenAIErrorResponse {
  return { error: { message, type, param, code } }
}

function badRequest(message: string, param: string | null = null): OpenAIErrorResponse {
  return errorResponse(message, 'invalid_request_error', param, 'invalid_request_error')
}

function notFound(model: string): OpenAIErrorResponse {
  return errorResponse(
    `The model '${model}' does not exist or you do not have access to it.`,
    'invalid_request_error',
    null,
    'model_not_found',
  )
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function validateRequest(
  body: unknown,
): { ok: true; request: ChatCompletionRequest } | { ok: false; error: OpenAIErrorResponse } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: badRequest('Request body must be a JSON object.') }
  }

  const req = body as Record<string, unknown>

  if (typeof req['model'] !== 'string' || !req['model']) {
    return { ok: false, error: badRequest('You must provide a model parameter.', 'model') }
  }

  if (!Array.isArray(req['messages']) || req['messages'].length === 0) {
    return {
      ok: false,
      error: badRequest(
        "'messages' is a required property. It must be a non-empty array.",
        'messages',
      ),
    }
  }

  // Validate each message has role and content
  for (let i = 0; i < req['messages'].length; i++) {
    const msg = req['messages'][i] as Record<string, unknown> | null
    if (!msg || typeof msg !== 'object') {
      return {
        ok: false,
        error: badRequest(`Invalid message at index ${i}.`, `messages[${i}]`),
      }
    }
    const role = msg['role']
    if (
      typeof role !== 'string' ||
      !['system', 'user', 'assistant', 'tool'].includes(role)
    ) {
      return {
        ok: false,
        error: badRequest(
          `Invalid value for 'role' at messages[${i}]. Expected one of 'system', 'user', 'assistant', 'tool'.`,
          `messages[${i}].role`,
        ),
      }
    }
  }

  return { ok: true, request: req as unknown as ChatCompletionRequest }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function createCompletionsRoute(config: CompletionsRouteConfig): Hono {
  const app = new Hono()
  const mapper = new OpenAICompletionMapper()

  app.post('/', async (c) => {
    // --- Parse body ---
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(badRequest('Could not parse the request body as valid JSON.'), 400)
    }

    // --- Validate ---
    const validation = validateRequest(body)
    if (!validation.ok) {
      return c.json(validation.error, 400)
    }
    const request = validation.request

    // --- Map to internal representation ---
    const mapped = mapper.mapRequest(request)

    // --- Resolve agent ---
    const agentDef = await config.agentStore.get(mapped.agentId)
    if (!agentDef) {
      return c.json(notFound(request.model), 404)
    }

    // --- Instantiate DzupAgent ---
    const agent = new DzupAgent({
      id: agentDef.id,
      name: agentDef.name,
      description: agentDef.description,
      instructions: agentDef.instructions,
      model: (agentDef.modelTier || 'chat') as 'chat' | 'reasoning' | 'codegen' | 'embedding',
      registry: config.modelRegistry,
    })

    const completionId = mapper.generateId()

    // --- Streaming mode ---
    if (request.stream === true) {
      return streamSSE(c, async (stream) => {
        const abortController = new AbortController()

        // Listen for client disconnect via the raw request signal
        const requestSignal = c.req.raw.signal
        const onAbort = (): void => { abortController.abort() }
        requestSignal.addEventListener('abort', onAbort, { once: true })

        stream.onAbort(() => {
          abortController.abort()
        })

        try {
          const iter = agent.stream([new HumanMessage(mapped.prompt)])

          for await (const event of iter) {
            // Stop iterating if client disconnected
            if (abortController.signal.aborted) {
              break
            }

            if (event.type === 'text') {
              const content =
                typeof event.data['content'] === 'string' ? event.data['content'] : ''
              if (content) {
                const chunk = mapper.mapChunk(content, request.model, completionId, 0, false)
                await stream.writeSSE({ data: JSON.stringify(chunk) })
              }
              continue
            }

            if (event.type === 'done') {
              // Emit final chunk with finish_reason
              const finalChunk = mapper.mapChunk('', request.model, completionId, 0, true)
              await stream.writeSSE({ data: JSON.stringify(finalChunk) })
              break
            }

            if (event.type === 'error') {
              const message =
                typeof event.data['message'] === 'string'
                  ? event.data['message']
                  : 'Internal error during streaming'
              const errorChunk = {
                error: {
                  message,
                  type: 'server_error',
                  param: null,
                  code: 'internal_error',
                },
              }
              await stream.writeSSE({ data: JSON.stringify(errorChunk) })
              break
            }

            if (event.type === 'tool_call') {
              const toolCall = event.data as { name?: string; args?: Record<string, unknown>; id?: string; index?: number }
              const toolIndex = typeof toolCall.index === 'number' ? toolCall.index : 0
              const toolId = typeof toolCall.id === 'string' ? toolCall.id : mapper.generateId()
              const toolName = typeof toolCall.name === 'string' ? toolCall.name : 'unknown'
              const toolArgs = typeof toolCall.args === 'object' && toolCall.args !== null
                ? JSON.stringify(toolCall.args)
                : ''

              // Emit initiation chunk
              const initChunk = mapper.mapToolCallInitChunk(toolId, toolName, toolIndex, request.model, completionId)
              await stream.writeSSE({ data: JSON.stringify(initChunk) })

              // Stream arguments (split into ~20-char fragments for realistic streaming)
              if (toolArgs) {
                const fragmentSize = 20
                for (let i = 0; i < toolArgs.length; i += fragmentSize) {
                  const fragment = toolArgs.slice(i, i + fragmentSize)
                  const argChunk = mapper.mapToolCallArgumentsChunk(fragment, toolIndex, request.model, completionId)
                  await stream.writeSSE({ data: JSON.stringify(argChunk) })
                }
              }

              // Emit finish_reason: tool_calls
              const finishChunk = mapper.mapToolCallsFinishChunk(request.model, completionId)
              await stream.writeSSE({ data: JSON.stringify(finishChunk) })
              continue
            }

            if (event.type === 'tool_result') {
              // Tool result is internal — agent will continue generating text after this
              // No chunk emitted; just continue the loop
              continue
            }

            // budget_warning, stuck — skip in OpenAI compat mode
          }
        } catch (err: unknown) {
          if (!abortController.signal.aborted) {
            const message = err instanceof Error ? err.message : 'Internal server error'
            const errorChunk = {
              error: {
                message,
                type: 'server_error',
                param: null,
                code: 'internal_error',
              },
            }
            try {
              await stream.writeSSE({ data: JSON.stringify(errorChunk) })
            } catch {
              // Stream already closed — nothing we can do
            }
          }
        } finally {
          requestSignal.removeEventListener('abort', onAbort)
        }

        // Emit the terminal [DONE] sentinel
        if (!abortController.signal.aborted) {
          try {
            await stream.writeSSE({ data: '[DONE]' })
          } catch {
            // Stream already closed
          }
        }
      })
    }

    // --- Non-streaming mode ---
    try {
      const result = await agent.generate([new HumanMessage(mapped.prompt)])

      const response = mapper.mapResponse(
        mapped.agentId,
        result.content,
        request.model,
        completionId,
      )

      // Override estimated token counts with actual usage from the agent
      response.usage = {
        prompt_tokens: result.usage.totalInputTokens,
        completion_tokens: result.usage.totalOutputTokens,
        total_tokens: result.usage.totalInputTokens + result.usage.totalOutputTokens,
      }

      // Refine finish_reason based on agent stop reason
      if (result.hitIterationLimit && response.choices[0]) {
        response.choices[0].finish_reason = 'length'
      }

      return c.json(response)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      console.error(`[OpenAI Completions] Error generating response: ${message}`)
      return c.json(
        errorResponse(message, 'server_error', null, 'internal_error'),
        500,
      )
    }
  })

  return app
}
