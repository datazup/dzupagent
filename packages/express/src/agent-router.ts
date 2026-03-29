import { Router } from 'express'
import { HumanMessage } from '@langchain/core/messages'
import type { DzipAgent } from '@dzipagent/agent'
import { SSEHandler } from './sse-handler.js'
import type { AgentRouterConfig, ChatRequestBody, AgentResult } from './types.js'

/**
 * Resolve the target agent from the request body.
 *
 * Falls back to the first agent in the config map when no agentName is
 * specified or when the requested name is not found.
 */
function resolveAgent(
  agents: Record<string, DzipAgent>,
  agentName?: string,
): { agent: DzipAgent; name: string } | null {
  if (agentName) {
    const agent = agents[agentName]
    if (agent) return { agent, name: agentName }
  }

  const firstKey = Object.keys(agents)[0]
  if (!firstKey) return null

  const agent = agents[firstKey]
  if (!agent) return null

  return { agent, name: firstKey }
}

/**
 * Create an Express router that exposes DzipAgent(s) as HTTP endpoints.
 *
 * Routes created:
 * - `POST /chat`      — SSE streaming response
 * - `POST /chat/sync` — JSON (non-streaming) response
 * - `GET  /health`    — Agent health / availability check
 *
 * All routes are relative to the `basePath` in config (default: '/').
 */
export function createAgentRouter(config: AgentRouterConfig): Router {
  const router = Router()
  const sseHandler = new SSEHandler(config.sse)
  const basePath = config.basePath ?? ''

  // Apply auth middleware to all routes if provided
  if (config.auth) {
    router.use(config.auth)
  }

  // ---------- POST /chat — SSE streaming ----------
  router.post(`${basePath}/chat`, async (req, res) => {
    const body = req.body as ChatRequestBody

    if (!body.message || typeof body.message !== 'string') {
      res.status(400).json({ error: 'Bad Request', message: '"message" field is required' })
      return
    }

    const resolved = resolveAgent(config.agents, body.agentName)
    if (!resolved) {
      res.status(503).json({ error: 'Service Unavailable', message: 'No agents configured' })
      return
    }

    const { agent, name: agentName } = resolved

    try {
      // Before-agent hook
      await config.hooks?.beforeAgent?.(req, agentName)

      const messages = [new HumanMessage(body.message)]
      const abortController = new AbortController()

      // Abort the agent when the client disconnects
      req.on('close', () => {
        abortController.abort()
      })

      const agentStream = agent.stream(messages, {
        signal: abortController.signal,
      })

      const result = await sseHandler.streamAgent(agentStream, res, req)

      // After-agent hook
      await config.hooks?.afterAgent?.(req, agentName, result)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      await config.hooks?.onError?.(req, error)

      // If headers are already sent (SSE started), send error as SSE event
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`)
        res.end()
      } else {
        res.status(500).json({
          error: 'Internal Server Error',
          message: error.message,
        })
      }
    }
  })

  // ---------- POST /chat/sync — JSON response ----------
  router.post(`${basePath}/chat/sync`, async (req, res) => {
    const body = req.body as ChatRequestBody

    if (!body.message || typeof body.message !== 'string') {
      res.status(400).json({ error: 'Bad Request', message: '"message" field is required' })
      return
    }

    const resolved = resolveAgent(config.agents, body.agentName)
    if (!resolved) {
      res.status(503).json({ error: 'Service Unavailable', message: 'No agents configured' })
      return
    }

    const { agent, name: agentName } = resolved

    try {
      await config.hooks?.beforeAgent?.(req, agentName)

      const messages = [new HumanMessage(body.message)]
      const startTime = Date.now()

      const generateResult = await agent.generate(messages)
      const durationMs = Date.now() - startTime

      const result: AgentResult = {
        content: generateResult.content,
        usage: {
          inputTokens: generateResult.usage.totalInputTokens,
          outputTokens: generateResult.usage.totalOutputTokens,
          totalTokens: generateResult.usage.totalInputTokens + generateResult.usage.totalOutputTokens,
        },
        toolCalls: generateResult.toolStats.length,
        durationMs,
      }

      await config.hooks?.afterAgent?.(req, agentName, generateResult)

      res.json({
        content: result.content,
        usage: result.usage,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      await config.hooks?.onError?.(req, error)

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message,
      })
    }
  })

  // ---------- GET /health ----------
  router.get(`${basePath}/health`, (_req, res) => {
    const agentNames = Object.keys(config.agents)
    res.json({
      status: 'ok',
      agents: agentNames,
      count: agentNames.length,
    })
  })

  return router
}
