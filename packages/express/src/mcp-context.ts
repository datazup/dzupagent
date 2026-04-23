import type { NextFunction, Request, Response } from 'express'
import type {
  MCPAuthFailurePayload,
  MCPRequestContextAuthConfig,
} from './types.js'

const MCP_REQUEST_CONTEXT = Symbol.for('@dzupagent/express/mcpRequestContext')

type RequestWithMcpContext = Request & {
  [MCP_REQUEST_CONTEXT]?: unknown
}

export function extractMcpCredential(
  req: Request,
  options: {
    credentialHeader?: string
    allowBearerAuth?: boolean
  } = {},
): string | null {
  const credentialHeader = (options.credentialHeader ?? 'x-mcp-api-key').toLowerCase()

  if (options.allowBearerAuth ?? true) {
    const authorization = req.headers.authorization
    if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
      const token = authorization.slice('bearer '.length).trim()
      if (token.length > 0) {
        return token
      }
    }
  }

  const direct = req.headers[credentialHeader]
  if (typeof direct === 'string') {
    const token = direct.trim()
    if (token.length > 0) {
      return token
    }
  }

  if (Array.isArray(direct)) {
    const token = direct[0]?.trim()
    if (token) {
      return token
    }
  }

  return null
}

export function setMcpRequestContext<TContext>(req: Request, context: TContext): void {
  ;(req as RequestWithMcpContext)[MCP_REQUEST_CONTEXT] = context
}

export function getMcpRequestContext<TContext>(req: Request): TContext | undefined {
  return (req as RequestWithMcpContext)[MCP_REQUEST_CONTEXT] as TContext | undefined
}

export function requireMcpRequestContext<TContext>(
  req: Request,
  message = 'MCP request context missing',
): TContext {
  const context = getMcpRequestContext<TContext>(req)
  if (!context) {
    throw new Error(message)
  }

  return context
}

export function createMcpRequestContextAuth<TContext>(
  config: MCPRequestContextAuthConfig<TContext>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next): void => {
    authenticateRequestContext(config, req, res, next).catch(next)
  }
}

async function authenticateRequestContext<TContext>(
  config: MCPRequestContextAuthConfig<TContext>,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const credentialOptions: {
    credentialHeader?: string
    allowBearerAuth?: boolean
  } = {}

  if (config.credentialHeader !== undefined) {
    credentialOptions.credentialHeader = config.credentialHeader
  }

  if (config.allowBearerAuth !== undefined) {
    credentialOptions.allowBearerAuth = config.allowBearerAuth
  }

  const credential = extractMcpCredential(req, credentialOptions)

  if (!credential) {
    await handleAuthFailure(config, {
      req,
      res,
      reason: 'missing_credentials',
    })
    return
  }

  const context = await config.resolveContext(credential, req)
  if (!context) {
    await handleAuthFailure(config, {
      req,
      res,
      reason: 'invalid_credentials',
    })
    return
  }

  setMcpRequestContext(req, context)
  config.assign?.(req, context)
  next()
}

async function handleAuthFailure<TContext>(
  config: MCPRequestContextAuthConfig<TContext>,
  context: {
    req: Request
    res: Response
    reason: 'missing_credentials' | 'invalid_credentials'
  },
): Promise<void> {
  if (config.onAuthFailure) {
    await config.onAuthFailure(context)
    return
  }

  context.res.status(401).json(createDefaultAuthFailurePayload(config, context.reason))
}

function createDefaultAuthFailurePayload<TContext>(
  config: MCPRequestContextAuthConfig<TContext>,
  reason: 'missing_credentials' | 'invalid_credentials',
): MCPAuthFailurePayload {
  return {
    error: 'Unauthorized',
    message: reason === 'missing_credentials'
      ? (config.missingCredentialMessage ?? 'MCP API key required')
      : (config.invalidCredentialMessage ?? 'Invalid MCP API key'),
    timestamp: new Date().toISOString(),
  }
}
