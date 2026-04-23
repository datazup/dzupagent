/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 *
 * This module re-implements the completions route with three gap fixes:
 *
 * GAP-1: System messages are extracted and composed with the stored agent
 *        instructions instead of being serialised into the flat prompt.
 *
 * GAP-2: Streaming finish_reason correctly emits 'length' when the agent
 *        hit its iteration or budget limit (hitIterationLimit from done event).
 *
 * GAP-3: Non-streaming responses include tool_calls in the choice message when
 *        the agent invoked tools during generation.
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HumanMessage } from '@langchain/core/messages'
import { DzupAgent } from '@dzupagent/agent'
import type { AgentExecutionSpecStore, ModelRegistry, DzupEventBus } from '@dzupagent/core'
import { OpenAICompletionMapper } from './completion-mapper.js'
import {
  mapRequest,
  mapFinalStreamChunk,
  mapResponseWithTools,
  validateCompletionRequest,
  notFoundError,
  serverError,
  generateCompletionId,
} from './request-mapper.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAICompatCompletionsConfig {
  agentStore: AgentExecutionSpecStore
  modelRegistry: ModelRegistry
  eventBus: DzupEventBus
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createOpenAICompatCompletionsRoute(
  config: OpenAICompatCompletionsConfig,
): Hono {
  const app = new Hono()
  /** Used for streaming text/tool chunks — GAP-2 is handled separately */
  const baseMapper = new OpenAICompletionMapper()

  app.post('/', async (c) => {
    // --- Parse body ---
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { message: 'Could not parse the request body as valid JSON.', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } },
        400,
      )
    }

    // --- Validate ---
    const validation = validateCompletionRequest(body)
    if (!validation.ok) {
      return c.json(validation.error, 400)
    }
    const request = validation.request

    // --- GAP-1: Extract system messages and map request ---
    const mapped = mapRequest(request)

    // --- Resolve agent ---
    const agentDef = await config.agentStore.get(mapped.agentId)
    if (!agentDef) {
      return c.json(notFoundError(request.model), 404)
    }

    // --- GAP-1: Compose system instructions ---
    // If the caller supplied system messages, they override the stored
    // agent instructions.  If no system message was provided, fall back
    // to the stored instructions.
    const effectiveInstructions = mapped.systemOverride !== null
      ? [agentDef.instructions, mapped.systemOverride].filter(Boolean).join('\n\n')
      : agentDef.instructions

    // --- Instantiate DzupAgent with composed instructions ---
    const agent = new DzupAgent({
      id: agentDef.id,
      name: agentDef.name,
      description: agentDef.description,
      instructions: effectiveInstructions,
      model: (agentDef.modelTier || 'chat') as 'chat' | 'reasoning' | 'codegen' | 'embedding',
      registry: config.modelRegistry,
      eventBus: config.eventBus,
    })

    const completionId = generateCompletionId()
    const promptMessage = new HumanMessage(mapped.prompt)

    // --- Streaming mode ---
    if (request.stream === true) {
      return streamSSE(c, async (stream) => {
        const abortController = new AbortController()

        const requestSignal = c.req.raw.signal
        const onAbort = (): void => { abortController.abort() }
        requestSignal.addEventListener('abort', onAbort, { once: true })

        stream.onAbort(() => {
          abortController.abort()
        })

        try {
          const iter = agent.stream([promptMessage])

          for await (const event of iter) {
            if (abortController.signal.aborted) break

            if (event.type === 'text') {
              const content =
                typeof event.data['content'] === 'string' ? event.data['content'] : ''
              if (content) {
                const chunk = baseMapper.mapChunk(content, request.model, completionId, 0, false)
                await stream.writeSSE({ data: JSON.stringify(chunk) })
              }
              continue
            }

            if (event.type === 'done') {
              // GAP-2: Use mapFinalStreamChunk so hitIterationLimit → 'length'
              const finalChunk = mapFinalStreamChunk(
                request.model,
                completionId,
                event.data,
              )
              await stream.writeSSE({ data: JSON.stringify(finalChunk) })
              break
            }

            if (event.type === 'error') {
              const message =
                typeof event.data['message'] === 'string'
                  ? event.data['message']
                  : 'Internal error during streaming'
              await stream.writeSSE({
                data: JSON.stringify({
                  error: { message, type: 'server_error', param: null, code: 'internal_error' },
                }),
              })
              break
            }

            if (event.type === 'tool_call') {
              const toolCall = event.data as {
                name?: string
                args?: Record<string, unknown>
                id?: string
                index?: number
              }
              const toolIndex = typeof toolCall.index === 'number' ? toolCall.index : 0
              const toolId = typeof toolCall.id === 'string' ? toolCall.id : generateCompletionId()
              const toolName = typeof toolCall.name === 'string' ? toolCall.name : 'unknown'
              const toolArgs =
                typeof toolCall.args === 'object' && toolCall.args !== null
                  ? JSON.stringify(toolCall.args)
                  : ''

              const initChunk = baseMapper.mapToolCallInitChunk(
                toolId, toolName, toolIndex, request.model, completionId,
              )
              await stream.writeSSE({ data: JSON.stringify(initChunk) })

              if (toolArgs) {
                const fragmentSize = 20
                for (let i = 0; i < toolArgs.length; i += fragmentSize) {
                  const fragment = toolArgs.slice(i, i + fragmentSize)
                  const argChunk = baseMapper.mapToolCallArgumentsChunk(
                    fragment, toolIndex, request.model, completionId,
                  )
                  await stream.writeSSE({ data: JSON.stringify(argChunk) })
                }
              }

              const finishChunk = baseMapper.mapToolCallsFinishChunk(request.model, completionId)
              await stream.writeSSE({ data: JSON.stringify(finishChunk) })
              continue
            }

            if (event.type === 'tool_result') {
              // Internal — no SSE chunk emitted
              continue
            }

            // budget_warning, stuck, adapter:* — skip in OpenAI compat mode
          }
        } catch (err: unknown) {
          if (!abortController.signal.aborted) {
            const message = err instanceof Error ? err.message : 'Internal server error'
            try {
              await stream.writeSSE({
                data: JSON.stringify(serverError(message)),
              })
            } catch {
              // Stream already closed
            }
          }
        } finally {
          requestSignal.removeEventListener('abort', onAbort)
        }

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
      const result = await agent.generate([promptMessage])

      // GAP-3: Use mapResponseWithTools to include tool_calls in response
      const response = mapResponseWithTools(
        result.content,
        request.model,
        completionId,
        {
          totalInputTokens: result.usage.totalInputTokens,
          totalOutputTokens: result.usage.totalOutputTokens,
        },
        result.messages,
        result.hitIterationLimit,
      )

      return c.json(response)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      console.error(`[OpenAI Compat] Error generating response: ${message}`)
      return c.json(serverError(message), 500)
    }
  })

  return app
}
