import { isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CodexAppServerStdioClient } from './codex-app-server-client.js'
import type { CodexAppServerClientOptions } from './codex-app-server-client-contracts.js'

export interface CodexNativeAuthModeOptions {
  readonly profileRoot: string
  readonly expectedMode: 'api_key' | 'subscription_cli'
  /** The host supplies its qualified executable and explicit sanitized environment. */
  readonly client: CodexAppServerClientOptions
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
}

function unqualified(): Error & { code: string } {
  return Object.assign(new Error('CODEX_NATIVE_AUTH_MODE_UNQUALIFIED'), { code: 'CODEX_NATIVE_AUTH_MODE_UNQUALIFIED' })
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Observe only native authentication mode, never account identity or credentials.
 * No turn starts and no login/config change is requested. Qualification of the
 * installed native binary's side effects remains the calling host's responsibility.
 */
export async function qualifyCodexNativeAuthMode(options: CodexNativeAuthModeOptions): Promise<{
  readonly mode: 'api_key' | 'subscription_cli'
}> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const { expectedMode, profileRoot, signal } = options
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000
    || typeof profileRoot !== 'string' || !isAbsolute(profileRoot)
    || resolve(profileRoot) !== profileRoot
    || !['api_key', 'subscription_cli'].includes(expectedMode)
    || !options.client?.env || options.client.env['CODEX_HOME'] !== profileRoot
    || Object.keys(options.client.env).some(key => /^OPENAI_/u.test(key) || key === 'CODEX_ACCESS_TOKEN')
    || signal?.aborted) throw unqualified()
  let client: CodexAppServerStdioClient | undefined
  const deadline = performance.now() + timeoutMs
  try {
    const limits = options.client.limits ?? {}
    client = await CodexAppServerStdioClient.connect({
      ...options.client, expectedCodexHome: profileRoot,
      env: Object.freeze({ ...options.client.env }),
      limits: {
        requestTimeoutMs: Math.min(limits.requestTimeoutMs ?? timeoutMs, timeoutMs),
        cleanupTimeoutMs: Math.min(limits.cleanupTimeoutMs ?? 1_000, timeoutMs),
        maxAggregateOutputBytes: Math.min(limits.maxAggregateOutputBytes ?? 65_536, 65_536),
        maxLineBytes: Math.min(limits.maxLineBytes ?? 32_768, 32_768),
        maxFrames: Math.min(limits.maxFrames ?? 32, 32),
        maxPendingRequests: Math.min(limits.maxPendingRequests ?? 2, 2),
        maxQueuedEvents: Math.min(limits.maxQueuedEvents ?? 8, 8),
      },
    }, { timeoutMs, ...(signal ? { signal } : {}) })
    const remaining = Math.floor(deadline - performance.now())
    if (remaining <= 0) throw unqualified()
    const result = await client.request('account/read', { refreshToken: false }, {
      timeoutMs: remaining, ...(signal ? { signal } : {}),
    })
    if (!record(result) || !record(result['account']) || typeof result['requiresOpenaiAuth'] !== 'boolean') throw unqualified()
    const type = result['account']['type']
    const mode = type === 'apiKey' ? 'api_key' : type === 'chatgpt' ? 'subscription_cli' : undefined
    if (mode === undefined || mode !== expectedMode || signal?.aborted) throw unqualified()
    return Object.freeze({ mode })
  } catch {
    throw unqualified()
  } finally {
    if (client) {
      try { await client.close() } catch { throw unqualified() }
    }
  }
}
