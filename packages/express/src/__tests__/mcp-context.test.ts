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

// Named so the casts below can target the augmented response rather than the
// bare `Response`: `res.status` must return `MockResponse`, and a cast through
// `Response['status']` returns plain `Response`, dropping statusMock/jsonMock.
type MockResponse = Response & {
  statusMock: ReturnType<typeof vi.fn>
  jsonMock: ReturnType<typeof vi.fn>
}

/**
 * Drain pending microtasks. Real timers are banned in tests by
 * `no-restricted-syntax`, and the auth middleware is fire-and-forget
 * (`authenticateRequestContext(...).catch(next)`), so there is no promise to
 * await -- the settling has to be drained instead.
 */
async function flushMicrotasks(hops = 20): Promise<void> {
  for (let i = 0; i < hops; i++) await Promise.resolve()
}

function createResponse(): MockResponse {
  const res = {} as MockResponse

  res.statusMock = vi.fn(() => res)
  res.jsonMock = vi.fn(() => res)
  res.status = res.statusMock as unknown as MockResponse['status']
  res.json = res.jsonMock as unknown as MockResponse['json']

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

  /**
   * Pins `MCPRequestContextFailureHandler = (context) => void`.
   *
   * The expression body is the point: `Array.prototype.push` returns `number`,
   * which the former `=> void | Promise<void>` rejected with TS2322. This file
   * is excluded from `tsconfig.json`, so the lock is enforced by
   * `tsconfig.flipcheck.json` and `scripts/check-test-typecheck.mjs`.
   */
  it('accepts an expression-bodied onAuthFailure that returns a value', async () => {
    const failures: string[] = []
    const auth = createMcpRequestContextAuth({
      resolveContext: async () => null,
      onAuthFailure: (context) => failures.push(context.reason),
    })
    const req = createRequest({ 'x-mcp-api-key': 'secret-token' })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    auth(req, res, next)
    await flushMicrotasks()

    // Assert the handler actually fired, so the type lock is not vacuous.
    expect(failures).toEqual(['invalid_credentials'])
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards an async onAuthFailure rejection to next', async () => {
    // `createMcpRequestContextAuth` routes rejections through `.catch(next)`.
    // That only reaches `next` because `handleAuthFailure` awaits the handler:
    // without the await the rejection escapes as an unhandled rejection and the
    // Express error pipeline never sees it.
    const failure = new Error('auth failure handler exploded')
    const auth = createMcpRequestContextAuth({
      resolveContext: async () => null,
      onAuthFailure: async () => {
        await Promise.resolve()
        throw failure
      },
    })
    const req = createRequest({ 'x-mcp-api-key': 'secret-token' })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    auth(req, res, next)
    await flushMicrotasks()

    expect(next).toHaveBeenCalledWith(failure)
  })
})
