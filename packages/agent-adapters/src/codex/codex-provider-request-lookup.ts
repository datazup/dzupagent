import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type {
  ProviderRequestLookupResult,
} from '../types.js'

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface CodexProviderRequestLookupOptions {
  cliPath?: string | undefined
  threadId: string
  timeoutMs?: number | undefined
  env?: Readonly<Record<string, string>> | undefined
  dependencies?: {
    spawn?: SpawnProcess | undefined
  } | undefined
}

/**
 * Inspect a persisted Codex thread through the authenticated local app-server.
 *
 * `thread/read` is read-only and does not create a model turn. The returned
 * projection intentionally excludes thread items, prompts, and responses.
 */
export async function lookupCodexProviderRequest(
  options: CodexProviderRequestLookupOptions,
): Promise<ProviderRequestLookupResult> {
  const threadId = String(options.threadId || '').trim()
  if (!threadId || threadId.length > 512) {
    return { state: 'unknown' }
  }
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) &&
    Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 30_000
  const spawnProcess = options.dependencies?.spawn ?? spawn

  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      options.cliPath ?? 'codex',
      ['app-server', '--stdio'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      },
    )
    let stdoutBuffer = ''
    let settled = false
    const finish = (
      error?: Error,
      result?: ProviderRequestLookupResult,
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolve(result ?? { state: 'unknown' })
    }
    const timer = setTimeout(
      () =>
        finish(
          new Error('Codex app-server provider request lookup timed out'),
        ),
      timeoutMs,
    )

    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (settled) return
      finish(
        new Error(
          `Codex app-server exited before thread lookup completed (code ${code ?? 'unknown'})`,
        ),
      )
    })
    child.stderr?.resume()
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      for (;;) {
        const boundary = stdoutBuffer.indexOf('\n')
        if (boundary < 0) break
        const line = stdoutBuffer.slice(0, boundary)
        stdoutBuffer = stdoutBuffer.slice(boundary + 1)
        const message = parseObject(line)
        if (!message) continue
        if (message['id'] === 0 && message['result']) {
          child.stdin?.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              method: 'initialized',
              params: {},
            })}\n`,
          )
          child.stdin?.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              method: 'thread/read',
              id: 1,
              params: { threadId, includeTurns: true },
            })}\n`,
          )
        } else if (message['id'] === 1) {
          if (message['error']) {
            const errorMessage = stringValue(
              objectValue(message['error'])['message'],
            )
            if (
              errorMessage &&
              /\b(?:not found|not loaded|unknown thread|does not exist)\b/iu.test(
                errorMessage,
              )
            ) {
              finish(undefined, { state: 'unknown' })
            } else {
              finish(
                new Error(
                  'Codex app-server thread/read failed',
                ),
              )
            }
            return
          }
          finish(
            undefined,
            normalizeCodexThreadReadResult(message['result'], threadId),
          )
          return
        }
      }
    })

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'dzupagent_provider_request_lookup',
            title: 'DzupAgent Provider Request Lookup',
            version: '0.2.0',
          },
        },
      })}\n`,
    )
  })
}

export function normalizeCodexThreadReadResult(
  value: unknown,
  retainedThreadId: string,
): ProviderRequestLookupResult {
  const thread = objectValue(objectValue(value)['thread'])
  const returnedThreadId = stringValue(thread['id'])
  if (!returnedThreadId || returnedThreadId !== retainedThreadId) {
    return { state: 'unknown' }
  }
  const threadStatus = stringValue(objectValue(thread['status'])['type'])
  const turns = Array.isArray(thread['turns'])
    ? thread['turns'].map(objectValue)
    : []
  const lastTurn = turns.at(-1) ?? {}
  const turnStatus = stringValue(lastTurn['status'])

  if (threadStatus === 'active' || turnStatus === 'inProgress') {
    return { state: 'in_flight', sessionId: returnedThreadId }
  }
  if (turnStatus === 'completed') {
    return {
      state: 'terminal',
      outcome: 'completed',
      sessionId: returnedThreadId,
    }
  }
  if (turnStatus === 'failed' || threadStatus === 'systemError') {
    return {
      state: 'terminal',
      outcome: 'failed',
      sessionId: returnedThreadId,
    }
  }
  if (turnStatus === 'interrupted') {
    return {
      state: 'terminal',
      outcome: 'cancelled',
      sessionId: returnedThreadId,
    }
  }
  return { state: 'unknown', sessionId: returnedThreadId }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
