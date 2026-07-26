import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  lookupCodexProviderRequest,
  normalizeCodexThreadReadResult,
} from '../codex/codex-provider-request-lookup.js'

function createAppServer(
  thread: Record<string, unknown>,
): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
  })
  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const boundary = buffer.indexOf('\n')
      if (boundary < 0) break
      const message = JSON.parse(buffer.slice(0, boundary)) as {
        id?: number
        method?: string
      }
      buffer = buffer.slice(boundary + 1)
      if (message.id === 0) {
        stdout.write('{"jsonrpc":"2.0","id":0,"result":{}}\n')
      }
      if (message.method === 'thread/read') {
        stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { thread },
          })}\n`,
        )
      }
    }
  })
  return child
}

function createMissingThreadAppServer(): ChildProcess {
  const child = createAppServer({})
  let buffer = ''
  child.stdin?.removeAllListeners('data')
  child.stdin?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const boundary = buffer.indexOf('\n')
      if (boundary < 0) break
      const message = JSON.parse(buffer.slice(0, boundary)) as {
        id?: number
        method?: string
      }
      buffer = buffer.slice(boundary + 1)
      if (message.id === 0) {
        child.stdout?.write('{"jsonrpc":"2.0","id":0,"result":{}}\n')
      }
      if (message.method === 'thread/read') {
        child.stdout?.write(
          '{"jsonrpc":"2.0","id":1,"error":{"message":"thread not loaded: missing"}}\n',
        )
      }
    }
  })
  return child
}

describe('Codex provider request restart lookup', () => {
  it('reads a terminal persisted thread without starting inference', async () => {
    const spawnCalls: Array<{
      command: string
      args: readonly string[]
    }> = []
    const result = await lookupCodexProviderRequest({
      cliPath: 'codex-test',
      threadId: 'thread-1',
      dependencies: {
        spawn(command, args) {
          spawnCalls.push({ command, args })
          return createAppServer({
            id: 'thread-1',
            status: { type: 'idle' },
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
          })
        },
      },
    })

    expect(spawnCalls).toEqual([{
      command: 'codex-test',
      args: ['app-server', '--stdio'],
    }])
    expect(result).toEqual({
      state: 'terminal',
      outcome: 'completed',
      sessionId: 'thread-1',
    })
  })

  it('keeps active and unknown threads nonterminal', () => {
    expect(
      normalizeCodexThreadReadResult({
        thread: {
          id: 'thread-2',
          status: { type: 'active', activeFlags: [] },
          turns: [{ id: 'turn-2', status: 'inProgress', items: [] }],
        },
      }, 'thread-2'),
    ).toEqual({ state: 'in_flight', sessionId: 'thread-2' })

    expect(
      normalizeCodexThreadReadResult({
        thread: {
          id: 'thread-3',
          status: { type: 'notLoaded' },
          turns: [],
        },
      }, 'thread-3'),
    ).toEqual({ state: 'unknown', sessionId: 'thread-3' })
  })

  it('maps an absent persisted thread to unknown', async () => {
    await expect(
      lookupCodexProviderRequest({
        threadId: 'missing',
        dependencies: {
          spawn: () => createMissingThreadAppServer(),
        },
      }),
    ).resolves.toEqual({ state: 'unknown' })
  })

  it('maps failed and interrupted turns without returning provider content', () => {
    const failed = normalizeCodexThreadReadResult({
      thread: {
        id: 'thread-4',
        status: { type: 'idle' },
        preview: 'private prompt',
        turns: [{
          id: 'turn-4',
          status: 'failed',
          error: { message: 'private provider error' },
          items: [{ type: 'agentMessage', text: 'private response' }],
        }],
      },
    }, 'thread-4')
    const interrupted = normalizeCodexThreadReadResult({
      thread: {
        id: 'thread-5',
        status: { type: 'idle' },
        turns: [{ id: 'turn-5', status: 'interrupted', items: [] }],
      },
    }, 'thread-5')

    expect(failed).toEqual({
      state: 'terminal',
      outcome: 'failed',
      sessionId: 'thread-4',
    })
    expect(interrupted).toEqual({
      state: 'terminal',
      outcome: 'cancelled',
      sessionId: 'thread-5',
    })
    expect(JSON.stringify(failed)).not.toContain('private')
  })
})
