import express, { Router } from 'express'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { z } from 'zod'
import { HumanMessage } from '@langchain/core/messages'
import type { DzupAgent } from '@dzupagent/agent'
import { defaultLogger, type FrameworkLogger } from '@dzupagent/core/utils'
import { SSEHandler } from './sse-handler.js'
import type { AgentRouterConfig, ChatRequestBody, AgentResult } from './types.js'

/**
 * Maximum length for an inbound `message` field — 32 KB.
 *
 * Independent from the JSON body cap so a request that fits within the body
 * limit can still be rejected when its message payload alone exceeds the
 * per-field policy.
 */
const MAX_MESSAGE_LENGTH = 32_768

/**
 * Default JSON body cap mounted by the router on `/chat*` routes.
 *
 * Hosts SHOULD also enforce a global limit upstream; this is a defense-in-depth
 * safety net specific to chat endpoints.
 */
const DEFAULT_BODY_LIMIT = '256kb'

/** Default rate-limit window: 1 minute. */
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000
/** Default rate-limit cap: 60 requests / window / IP. */
const DEFAULT_RATE_LIMIT_MAX = 60

/**
 * Zod schema for the `/chat` and `/chat/sync` request body.
 *
 * Validates the public contract (`message`, `agentName`, `metadata`) but
 * tolerates additional legacy/optional fields by `.passthrough()` so existing
 * callers carrying `conversationId`, `model`, `configurable`, etc. continue
 * to work.
 */
export const ChatRequestSchema = z
  .object({
    message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
    agentName: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

/**
 * Wraps an async Express route handler so it returns void and forwards
 * any rejected promise to the next error-handling middleware.
 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next): void => {
    fn(req, res, next).catch(next)
  }
}

/**
 * Resolve the target agent from a validated request body.
 *
 * Falls back to the first agent in the config map only when no `agentName`
 * is specified. Unknown `agentName` values are rejected upstream by the
 * caller (do NOT silently fall through).
 */
function resolveAgent(
  agents: Record<string, DzupAgent>,
  agentName?: string,
): { agent: DzupAgent; name: string } | null {
  if (agentName) {
    const agent = agents[agentName]
    if (agent) return { agent, name: agentName }
    return null
  }

  const firstKey = Object.keys(agents)[0]
  if (!firstKey) return null

  const agent = agents[firstKey]
  if (!agent) return null

  return { agent, name: firstKey }
}

/** Format a Zod issue list into a stable, structured 400 payload. */
function buildValidationError(issues: z.ZodIssue[]): {
  error: string
  code: string
  message: string
  issues: Array<{ path: string; message: string; code: string }>
} {
  return {
    error: 'Bad Request',
    code: 'VALIDATION_ERROR',
    message: issues[0]?.message ?? 'Invalid request body',
    issues: issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    })),
  }
}

/**
 * Validate the JSON body against `ChatRequestSchema`.
 *
 * On failure: write a 400 with the structured error and return `null`.
 * On success: return the parsed body typed as `ChatRequestBody`.
 */
function parseChatBody(req: Request, res: Response): ChatRequestBody | null {
  const parsed = ChatRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json(buildValidationError(parsed.error.issues))
    return null
  }
  return parsed.data as ChatRequestBody
}

/**
 * Validate that `agentName` (if provided) is in the configured allowlist.
 *
 * On failure: write a 400 with `UNKNOWN_AGENT` and return `false`.
 */
function ensureAgentAllowed(
  agents: Record<string, DzupAgent>,
  agentName: string | undefined,
  res: Response,
): boolean {
  if (!agentName) return true
  if (Object.prototype.hasOwnProperty.call(agents, agentName)) return true
  res.status(400).json({
    error: 'Bad Request',
    code: 'UNKNOWN_AGENT',
    message: `Unknown agentName: ${agentName}`,
  })
  return false
}

/**
 * Build the rate-limiting middleware for `/chat*` routes.
 *
 * Returns a no-op pass-through when `rateLimit === false`.
 */
function buildRateLimiter(config: AgentRouterConfig): RequestHandler {
  if (config.rateLimit === false) {
    return (_req, _res, next): void => next()
  }
  const windowMs = config.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
  const max = config.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Resolve the per-IP key defensively. `req.ip` reads `req.socket.remoteAddress`,
    // which can be undefined in tests / mock harnesses; fall back to a header /
    // known-unknown sentinel so the limiter never crashes the request. The
    // resolved IP is then normalised through `ipKeyGenerator` for IPv6 safety.
    keyGenerator: (req): string => {
      let ip: string | undefined
      try {
        ip = req.ip
      } catch {
        /* fall through */
      }
      if (!ip) {
        const fwd = req.headers['x-forwarded-for']
        if (typeof fwd === 'string' && fwd.length > 0) ip = fwd.split(',')[0]!.trim()
      }
      if (!ip) {
        ip = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
      }
      return ipKeyGenerator(ip ?? 'unknown')
    },
    handler: (_req, res) => {
      res.status(429).json({
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded',
      })
    },
  })
}

/**
 * Build the body-size middleware for `/chat*` routes.
 *
 * Wraps the underlying `express.json` parser so a `PayloadTooLargeError`
 * is converted to a clean `413` JSON response (instead of being thrown
 * past application middleware).
 */
function buildBodyParser(config: AgentRouterConfig): RequestHandler {
  const limit = config.bodyLimit ?? DEFAULT_BODY_LIMIT
  const parser = express.json({ limit })
  return (req, res, next): void => {
    parser(req, res, (err?: unknown) => {
      if (!err) {
        next()
        return
      }
      const errorObj = err as { type?: string; status?: number; statusCode?: number }
      const status = errorObj.status ?? errorObj.statusCode
      if (errorObj.type === 'entity.too.large' || status === 413) {
        res.status(413).json({
          error: 'Payload Too Large',
          code: 'BODY_TOO_LARGE',
          message: `Request body exceeds limit (${limit})`,
        })
        return
      }
      if (status === 400 || errorObj.type === 'entity.parse.failed') {
        res.status(400).json({
          error: 'Bad Request',
          code: 'INVALID_JSON',
          message: 'Request body is not valid JSON',
        })
        return
      }
      next(err)
    })
  }
}

/**
 * Sanitised global error handler. Returns a generic message to the client and
 * logs the real error server-side via the structured logger.
 */
function buildErrorHandler(logger: FrameworkLogger) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    const error = err instanceof Error ? err : new Error(String(err))
    logger.error('[express/agent-router] unhandled route error', {
      message: error.message,
      stack: error.stack,
      path: req.path,
      method: req.method,
    })
    if (res.headersSent) {
      next(err)
      return
    }
    res.status(500).json({
      error: 'Internal error',
      code: 'INTERNAL_ERROR',
    })
  }
}

/**
 * Create an Express router that exposes DzupAgent(s) as HTTP endpoints.
 *
 * Routes created:
 * - `POST /chat`      — SSE streaming response
 * - `POST /chat/sync` — JSON (non-streaming) response
 * - `GET  /health`    — Agent health / availability check
 *
 * Hardening (RF-02 / SEC-04):
 * - 256kb body cap mounted on `/chat*` (configurable via `bodyLimit`)
 * - Zod-validated request body (`ChatRequestSchema`)
 * - Per-IP rate limit on `/chat*` (default 60 req/min, configurable via `rateLimit`)
 * - Agent allowlist enforced — unknown `agentName` → 400
 * - Sanitised error responses — `{ error: 'Internal error', code: 'INTERNAL_ERROR' }`
 *
 * All routes are relative to the `basePath` in config (default: '/').
 */
export function createAgentRouter(config: AgentRouterConfig): Router {
  const router = Router()
  const sseHandler = new SSEHandler(config.sse)
  const basePath = config.basePath ?? ''
  const logger = config.logger ?? defaultLogger

  // Apply auth middleware to all routes if provided
  if (config.auth) {
    router.use(config.auth)
  }

  const bodyParser = buildBodyParser(config)
  const limiter = buildRateLimiter(config)

  // ---------- POST /chat — SSE streaming ----------
  router.post(
    `${basePath}/chat`,
    bodyParser,
    limiter,
    asyncHandler(async (req, res) => {
      const body = parseChatBody(req, res)
      if (!body) return

      if (!ensureAgentAllowed(config.agents, body.agentName, res)) return

      const resolved = resolveAgent(config.agents, body.agentName)
      if (!resolved) {
        res.status(503).json({
          error: 'Service Unavailable',
          code: 'NO_AGENTS',
          message: 'No agents configured',
        })
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

        logger.error('[express/agent-router] /chat handler error', {
          message: error.message,
          stack: error.stack,
        })

        // If headers are already sent (SSE started), send a generic SSE error event
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ error: 'Internal error', code: 'INTERNAL_ERROR' })}\n\n`)
          res.end()
        } else {
          res.status(500).json({
            error: 'Internal error',
            code: 'INTERNAL_ERROR',
          })
        }
      }
    }),
  )

  // ---------- POST /chat/sync — JSON response ----------
  router.post(
    `${basePath}/chat/sync`,
    bodyParser,
    limiter,
    asyncHandler(async (req, res) => {
      const body = parseChatBody(req, res)
      if (!body) return

      if (!ensureAgentAllowed(config.agents, body.agentName, res)) return

      const resolved = resolveAgent(config.agents, body.agentName)
      if (!resolved) {
        res.status(503).json({
          error: 'Service Unavailable',
          code: 'NO_AGENTS',
          message: 'No agents configured',
        })
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
            totalTokens:
              (generateResult.usage.totalInputTokens ?? 0) + (generateResult.usage.totalOutputTokens ?? 0),
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

        logger.error('[express/agent-router] /chat/sync handler error', {
          message: error.message,
          stack: error.stack,
        })

        res.status(500).json({
          error: 'Internal error',
          code: 'INTERNAL_ERROR',
        })
      }
    }),
  )

  // ---------- GET /health ----------
  router.get(`${basePath}/health`, (_req, res) => {
    const agentNames = Object.keys(config.agents)
    res.json({
      status: 'ok',
      agents: agentNames,
      count: agentNames.length,
    })
  })

  // ---------- Sanitised error handler (last) ----------
  router.use(buildErrorHandler(logger))

  return router
}
