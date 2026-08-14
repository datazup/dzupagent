import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  CodexAppServerClientError,
  CodexAppServerStdioClient,
} from './codex-app-server-client.js'

interface RpcFrame {
  readonly id?: number | string | undefined
  readonly method?: string | undefined
  readonly params?: Record<string, unknown> | undefined
}

interface FakeProcess {
  readonly child: ChildProcess
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly frames: RpcFrame[]
}

interface FakeProcessOptions {
  readonly autoInitialize?: boolean | undefined
  readonly killExits?: boolean | undefined
  readonly onKill?: ((signal: NodeJS.Signals | number | undefined, process: FakeProcess) => void) | undefined
}

function fakeProcess(
  onFrame?: (frame: RpcFrame, process: FakeProcess) => void,
  options: FakeProcessOptions = {},
): FakeProcess {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const frames: RpcFrame[] = []
  const process: FakeProcess = { child, stdout, stderr, frames }
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      if (options.onKill) options.onKill(signal, process)
      else if (options.killExits ?? true) queueMicrotask(() => child.emit('exit', 0, null))
      return true
    }),
  })

  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const boundary = buffer.indexOf('\n')
      if (boundary < 0) break
      const frame = JSON.parse(buffer.slice(0, boundary)) as RpcFrame
      buffer = buffer.slice(boundary + 1)
      frames.push(frame)
      if (frame.method === 'initialize' && options.autoInitialize !== false) {
        respond(process, frame.id, {})
      } else {
        onFrame?.(frame, process)
      }
    }
  })
  return process
}

function respond(process: FakeProcess, id: RpcFrame['id'], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

async function connect(
  process: FakeProcess,
  limits: Parameters<typeof CodexAppServerStdioClient.connect>[0]['limits'] = {},
): Promise<CodexAppServerStdioClient> {
  return CodexAppServerStdioClient.connect({
    executable: {
      name: 'codex',
      path: '/fixture/codex',
      realPath: '/fixture/codex',
    },
    limits,
    dependencies: {
      spawn: () => process.child,
      realpath: async (path) => path,
      stat: async () => ({ isFile: () => true }),
      access: async () => undefined,
    },
  })
}

describe('Codex App Server bounded stdio client', () => {
  it('initializes once and correlates monotonic request ids', async () => {
    const process = fakeProcess((frame, current) => {
      if (frame.id !== undefined) respond(current, frame.id, { method: frame.method })
    })
    const client = await connect(process)

    await expect(client.request('thread/start', {})).resolves.toEqual({
      method: 'thread/start',
    })
    await expect(client.request('turn/start', {})).resolves.toEqual({
      method: 'turn/start',
    })
    expect(process.frames.map((frame) => [frame.id, frame.method])).toEqual([
      [1, 'initialize'],
      [undefined, 'initialized'],
      [2, 'thread/start'],
      [3, 'turn/start'],
    ])
    expect(process.frames.every((frame) => !Object.hasOwn(frame, 'jsonrpc'))).toBe(true)
    await client.close()
  })

  it('accepts a chunk containing several individually bounded frames', async () => {
    const process = fakeProcess((frame, current) => {
      if (frame.method !== 'thread/start') return
      const lines = [
        JSON.stringify({ id: frame.id, result: { thread: { id: 'thread-1' } } }),
        ...Array.from({ length: 8 }, (_, index) => JSON.stringify({
          method: 'fixture/event',
          params: { index },
        })),
      ]
      current.stdout.write(`${lines.join('\n')}\n`)
    })
    const client = await connect(process, {
      maxLineBytes: 256,
      maxQueuedEvents: 16,
    })

    await expect(client.request('thread/start', {})).resolves.toEqual({
      thread: { id: 'thread-1' },
    })
    await client.close()
  })

  it('terminates on malformed, duplicate, and late responses', async () => {
    const malformed = fakeProcess((frame, current) => {
      if (frame.method === 'thread/start') current.stdout.write('{bad json\n')
    })
    const malformedClient = await connect(malformed)
    await expect(malformedClient.request('thread/start', {})).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_MALFORMED_FRAME',
    })

    const duplicate = fakeProcess((frame, current) => {
      if (frame.method !== 'thread/start') return
      respond(current, frame.id, {})
      respond(current, frame.id, {})
    })
    const duplicateClient = await connect(duplicate)
    await expect(duplicateClient.request('thread/start', {})).resolves.toEqual({})
    await expect(duplicateClient.request('turn/start', {})).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_DUPLICATE_RESPONSE',
    })

    const late = fakeProcess((frame, current) => {
      if (frame.method === 'thread/start') respond(current, 999, {})
    })
    const lateClient = await connect(late)
    await expect(lateClient.request('thread/start', {})).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_LATE_RESPONSE',
    })
  })

  it('terminates on request timeout, line/output overflow, and process death', async () => {
    const hanging = fakeProcess()
    const hangingClient = await connect(hanging, { requestTimeoutMs: 15 })
    await expect(hangingClient.request('thread/start', {})).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_TIMEOUT',
    })

    const overflow = fakeProcess((frame, current) => {
      if (frame.method === 'thread/start') current.stderr.write('x'.repeat(101))
    })
    const overflowClient = await connect(overflow, {
      maxAggregateOutputBytes: 100,
    })
    await expect(overflowClient.request('thread/start', {})).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_OUTPUT_LIMIT',
    })

    const longLine = fakeProcess((frame, current) => {
      if (frame.method === 'thread/start') current.stdout.write('x'.repeat(257))
    })
    const longLineClient = await connect(longLine, { maxLineBytes: 256 })
    await expect(longLineClient.request('thread/start', {})).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_LINE_LIMIT',
    })

    const death = fakeProcess((frame, current) => {
      if (frame.method === 'thread/start') current.child.emit('exit', 23, null)
    })
    const deathClient = await connect(death)
    await expect(deathClient.request('thread/start', {})).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_PROCESS_DIED',
    })
  })

  it('lets callers tighten request time without expanding the configured maximum', async () => {
    vi.useFakeTimers()
    try {
      const tightenedClient = await connect(fakeProcess(), { requestTimeoutMs: 50 })
      const tightened = expect(tightenedClient.request(
        'thread/start',
        {},
        { timeoutMs: 5 },
      )).rejects.toMatchObject({ code: 'CODEX_APP_SERVER_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(5)
      await tightened

      const cappedClient = await connect(fakeProcess(), { requestTimeoutMs: 5 })
      const capped = expect(cappedClient.request(
        'thread/start',
        {},
        { timeoutMs: 50 },
      )).rejects.toMatchObject({ code: 'CODEX_APP_SERVER_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(5)
      await capped
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds pending requests and fails closed when cleanup cannot terminate the child', async () => {
    const pending = fakeProcess()
    const pendingClient = await connect(pending, { maxPendingRequests: 1 })
    const first = pendingClient.request('thread/start', {})
    const second = pendingClient.request('turn/start', {})
    const settled = await Promise.allSettled([first, second])
    expect(settled.every((result) => result.status === 'rejected')).toBe(true)
    expect(settled.some((result) =>
      result.status === 'rejected'
      && result.reason instanceof CodexAppServerClientError
      && result.reason.code === 'CODEX_APP_SERVER_PENDING_LIMIT')).toBe(true)

    const stubborn = fakeProcess(undefined, { killExits: false })
    const stubbornClient = await connect(stubborn, { cleanupTimeoutMs: 5 })
    await expect(stubbornClient.close()).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_CLEANUP_FAILED',
    })
  })

  it('awaits bounded SIGTERM-to-SIGKILL cleanup when initialization fails', async () => {
    vi.useFakeTimers()
    try {
      const signals: Array<NodeJS.Signals | number | undefined> = []
      const stubbornUntilKill = fakeProcess(undefined, {
        autoInitialize: false,
        onKill: (signal, process) => {
          signals.push(signal)
          if (signal === 'SIGKILL') queueMicrotask(() => process.child.emit('exit', 0, null))
        },
      })
      const timedOut = connect(stubbornUntilKill, {
        requestTimeoutMs: 5,
        cleanupTimeoutMs: 5,
      })
      const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
        code: 'CODEX_APP_SERVER_TIMEOUT',
      })

      await vi.advanceTimersByTimeAsync(10)

      await timedOutExpectation
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])

      const neverExitsSignals: Array<NodeJS.Signals | number | undefined> = []
      const neverExits = fakeProcess(undefined, {
        autoInitialize: false,
        onKill: (signal) => neverExitsSignals.push(signal),
      })
      const uncleanable = connect(neverExits, {
        requestTimeoutMs: 5,
        cleanupTimeoutMs: 5,
      })
      const uncleanableExpectation = expect(uncleanable).rejects.toMatchObject({
        code: 'CODEX_APP_SERVER_CLEANUP_FAILED',
      })

      await vi.advanceTimersByTimeAsync(15)

      await uncleanableExpectation
      expect(neverExitsSignals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })
})
