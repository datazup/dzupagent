import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { isMCPRequest } from '@dzupagent/core'
import type { MCPRequest, MCPRequestId } from '@dzupagent/core'
import type { MCPRequestHandler, MCPRouterConfig } from './types.js'

const JSON_RPC_INVALID_REQUEST = -32600
const JSON_RPC_INTERNAL_ERROR = -32603

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next): void => {
    fn(req, res, next).catch(next)
  }
}

export function createMcpRouter(config: MCPRouterConfig): Router {
  const router = Router()
  const basePath = config.basePath ?? '/mcp'
  const exposeTools = config.expose?.tools ?? true
  const exposeResources = config.expose?.resources ?? true
  const exposeResourceTemplates = config.expose?.resourceTemplates ?? true

  if (config.auth) {
    router.use(config.auth)
  }

  router.post(basePath, asyncHandler(async (req, res) => {
    const body = req.body as unknown
    if (!isMCPRequest(body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_INVALID_REQUEST,
          message: 'Invalid MCP request',
        },
      })
      return
    }

    try {
      const server = await resolveServer(config, req)
      await config.hooks?.beforeRequest?.(req, body)

      const response = await server.handleRequest(body)

      await config.hooks?.afterRequest?.(req, body, response)

      if (response === null) {
        res.status(204).end()
        return
      }

      res.json(response)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const requestId = extractRequestId(body)
      await config.hooks?.onError?.(req, error, requestId)

      res.status(500).json({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message: error.message,
        },
      })
    }
  }))

  if (exposeTools) {
    router.get(`${basePath}/tools`, asyncHandler(async (req, res) => {
      const server = await resolveServer(config, req)
      res.json({ tools: server.listTools() })
    }))
  }

  if (exposeResources) {
    router.get(`${basePath}/resources`, asyncHandler(async (req, res) => {
      const server = await resolveServer(config, req)
      res.json({ resources: server.listResources?.() ?? [] })
    }))
  }

  if (exposeResourceTemplates) {
    router.get(`${basePath}/resource-templates`, asyncHandler(async (req, res) => {
      const server = await resolveServer(config, req)
      res.json({ resourceTemplates: server.listResourceTemplates?.() ?? [] })
    }))
  }

  return router
}

async function resolveServer(
  config: MCPRouterConfig,
  req: Request,
): Promise<MCPRequestHandler> {
  if (typeof config.server === 'function') {
    return await config.server(req)
  }

  return config.server
}

function extractRequestId(input: unknown): MCPRequestId {
  if (!input || typeof input !== 'object') return null

  const candidate = input as Partial<MCPRequest>
  if (!Object.prototype.hasOwnProperty.call(candidate, 'id')) {
    return null
  }

  return candidate.id ?? null
}
