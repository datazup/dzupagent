import { describe, expect, it, vi, beforeEach } from 'vitest'
import { qualifyCodexNativeAuthMode } from './codex-native-auth-mode.js'

const client = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn(), close: vi.fn() }))
vi.mock('./codex-app-server-client.js', () => ({
  CodexAppServerStdioClient: { connect: client.connect },
}))

const options = {
  profileRoot: '/approved/native-context', expectedMode: 'api_key' as const,
  client: {
    executable: { name: 'codex' as const, path: '/approved/codex', realPath: '/approved/codex', artifactDigest: `sha256:${'a'.repeat(64)}` },
    env: { CODEX_HOME: '/approved/native-context' },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  client.connect.mockResolvedValue({ request: client.request, close: client.close })
  client.close.mockResolvedValue(undefined)
})

describe('type-only native Codex auth-mode observation', () => {
  it.each([['apiKey', 'api_key'], ['chatgpt', 'subscription_cli']] as const)('reduces %s to mode only and always closes', async (type, mode) => {
    client.request.mockResolvedValue({ account: { type, email: 'fixture-private', accountId: 'fixture-private' }, requiresOpenaiAuth: true })
    expect(await qualifyCodexNativeAuthMode({ ...options, expectedMode: mode })).toEqual({ mode })
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ expectedCodexHome: options.profileRoot }), expect.any(Object))
    expect(client.request).toHaveBeenCalledWith('account/read', { refreshToken: false }, expect.any(Object))
    expect(client.close).toHaveBeenCalledOnce()
  })

  it.each([null, {}, { account: null }, { account: { type: 'unknown' } },
    { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }])('holds unknown, missing or mismatched observations %j', async result => {
    client.request.mockResolvedValue(result)
    await expect(qualifyCodexNativeAuthMode(options)).rejects.toMatchObject({ code: 'CODEX_NATIVE_AUTH_MODE_UNQUALIFIED' })
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('does not return raw provider errors and closes on RPC failure', async () => {
    client.request.mockRejectedValue(new Error('fixture-private-provider-output'))
    await expect(qualifyCodexNativeAuthMode(options)).rejects.toThrow(/^CODEX_NATIVE_AUTH_MODE_UNQUALIFIED$/)
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('holds a valid observation when native cleanup fails', async () => {
    client.request.mockResolvedValue({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })
    client.close.mockRejectedValueOnce(new Error('fixture-private-cleanup-output'))
    await expect(qualifyCodexNativeAuthMode(options)).rejects.toThrow(/^CODEX_NATIVE_AUTH_MODE_UNQUALIFIED$/)
  })

  it('keeps the requested mode stable while opening the native client', async () => {
    const changing = { ...options, expectedMode: 'api_key' as 'api_key' | 'subscription_cli' }
    client.connect.mockImplementationOnce(async () => {
      changing.expectedMode = 'subscription_cli'
      return { request: client.request, close: client.close }
    })
    client.request.mockResolvedValue({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true })
    await expect(qualifyCodexNativeAuthMode(changing)).rejects.toMatchObject({ code: 'CODEX_NATIVE_AUTH_MODE_UNQUALIFIED' })
  })

  it.each([
    { profileRoot: '/different/context' },
    { client: { ...options.client, env: { ...options.client.env, OPENAI_API_KEY: 'fixture-only' } } },
    { timeoutMs: 0 }, { timeoutMs: Infinity },
  ])('rejects unsafe input before opening native context %j', async patch => {
    await expect(qualifyCodexNativeAuthMode({ ...options, ...patch })).rejects.toMatchObject({ code: 'CODEX_NATIVE_AUTH_MODE_UNQUALIFIED' })
    expect(client.connect).not.toHaveBeenCalled()
  })
})
