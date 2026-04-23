import type { NextFunction, Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMcpRequestContextAuth,
  extractMcpCredential,
  getMcpRequestContext,
  requireMcpRequestContext,
} from '../mcp-context.js'

function createRequest(headers: Record<string, string> = {}): Request {
  return {
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  } as Request
}

function createResponse(): Response & {
  statusMock: ReturnType<typeof vi.fn>
  jsonMock: ReturnType<typeof vi.fn>
} {
  const res = {} as Response & {
    statusMock: ReturnType<typeof vi.fn>
    jsonMock: ReturnType<typeof vi.fn>
  }

  res.statusMock = vi.fn(() => res)
  res.jsonMock = vi.fn(() => res)
  res.status = res.statusMock as unknown as Response['status']
  res.json = res.jsonMock as unknown as Response['json']

  return res
}

describe('mcp-context helpers', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('extracts MCP credentials from bearer auth and direct headers', () => {
    expect(extractMcpCredential(createRequest({
      authorization: 'Bearer secret-token',
    }))).toBe('secret-token')

    expect(extractMcpCredential(createRequest({
      'x-mcp-api-key': 'direct-secret',
    }))).toBe('direct-secret')

    expect(extractMcpCredential(createRequest({
      'x-custom-mcp-key': 'custom-secret',
    }), {
      credentialHeader: 'x-custom-mcp-key',
      allowBearerAuth: false,
    })).toBe('custom-secret')
  })

  it('stores and requires MCP request context after successful auth', async () => {
    const auth = createMcpRequestContextAuth({
      resolveContext: async (credential) => ({ credential, tenantId: 'tenant-1' }),
    })
    const req = createRequest({ authorization: 'Bearer secret-token' })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    auth(req, res, next)
    await Promise.resolve()

    expect(next).toHaveBeenCalledTimes(1)
    expect(getMcpRequestContext<{ credential: string; tenantId: string }>(req)).toEqual({
      credential: 'secret-token',
      tenantId: 'tenant-1',
    })
    expect(requireMcpRequestContext<{ credential: string; tenantId: string }>(req)).toEqual({
      credential: 'secret-token',
      tenantId: 'tenant-1',
    })
    expect(res.statusMock).not.toHaveBeenCalled()
  })

  it('returns the default unauthorized payload when credentials are missing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T12:00:00.000Z'))

    const auth = createMcpRequestContextAuth({
      resolveContext: async () => ({ tenantId: 'tenant-1' }),
    })
    const req = createRequest()
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    auth(req, res, next)
    await Promise.resolve()

    expect(next).not.toHaveBeenCalled()
    expect(res.statusMock).toHaveBeenCalledWith(401)
    expect(res.jsonMock).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'MCP API key required',
      timestamp: '2026-04-23T12:00:00.000Z',
    })
  })

  it('supports custom invalid-credential handling', async () => {
    const onAuthFailure = vi.fn(({ res }: { res: Response }) => {
      res.status(403).json({ error: 'Forbidden', message: 'Denied' })
    })
    const auth = createMcpRequestContextAuth({
      resolveContext: async () => null,
      assign: (req, context: { tenantId: string }) => {
        ;(req as Request & { tenantId?: string }).tenantId = context.tenantId
      },
      onAuthFailure,
      invalidCredentialMessage: 'Invalid token',
    })
    const req = createRequest({ 'x-mcp-api-key': 'secret-token' })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    auth(req, res, next)
    await Promise.resolve()

    expect(next).not.toHaveBeenCalled()
    expect(onAuthFailure).toHaveBeenCalledWith({
      req,
      res,
      reason: 'invalid_credentials',
    })
    expect(res.statusMock).toHaveBeenCalledWith(403)
    expect(res.jsonMock).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: 'Denied',
    })
  })
})
