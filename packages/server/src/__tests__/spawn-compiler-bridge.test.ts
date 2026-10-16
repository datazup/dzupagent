/**
 * SpawnCompilerBridge unit tests.
 *
 * Tests focus on the NDJSON→SSE mapping logic. We mock node:child_process so
 * tests are fast and deterministic. The integration path (real binary) is
 * covered by flow-compiler bin/ smoke tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter, Readable, PassThrough } from 'node:stream'
import { secureLogger } from '@dzupagent/core/utils'
import { buildCompileResultEvent } from '../routes/compile-result-event.js'

// ---- child_process mock ----------------------------------------------------

type StdinMock = EventEmitter & {
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}
type ChildMock = EventEmitter & {
  stdout: Readable
  stderr: Readable
  stdin: StdinMock
  kill: ReturnType<typeof vi.fn>
}

function makeStdin(): StdinMock {
  const stdin = new EventEmitter() as StdinMock
  stdin.write = vi.fn()
  stdin.end = vi.fn()
  return stdin
}

function makeChild(lines: string[]): ChildMock {
  const child = new EventEmitter() as ChildMock
  const content = lines.map((l) => `${l}\n`).join('')
  child.stdout = Readable.from(content)
  child.stderr = Readable.from('')
  child.stdin = makeStdin()
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit('close', 0))
  })
  // Emit close when stdout ends OR is destroyed
  const fireClose = (): void => {
    setImmediate(() => child.emit('close', 0))
  }
  child.stdout.on('end', fireClose)
  child.stdout.on('close', fireClose)
  setImmediate(() => child.emit('spawn'))
  return child
}

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

vi.mock('node:module', () => ({
  createRequire: () => (id: string) => {
    if (id === '@dzupagent/flow-compiler') return '/mock/flow-compiler/dist/index.js'
    throw new Error(`Cannot find module '${id}'`)
  },
}))

// ---------------------------------------------------------------------------

const { spawn } = await import('node:child_process')
const spawnMock = spawn as ReturnType<typeof vi.fn>

// Collected SSE events from a mock stream
interface SseEvent { event: string; data: string }

function makeStream(): { stream: { writeSSE: (e: SseEvent) => Promise<void>; onAbort: (fn: () => void) => void }; events: SseEvent[] } {
  const events: SseEvent[] = []
  return {
    stream: {
      writeSSE: vi.fn(async (e: SseEvent) => { events.push(e) }),
      onAbort: vi.fn(),
    },
    events,
  }
}

// Minimal Hono context mock
/** The Hono `Context` the subject takes. */
type CompileCtx = Parameters<typeof handleSubprocessCompile>[0]

/**
 * A stand-in for the Hono context. `handleSubprocessCompile` reads only
 * `req.query`, `req.method`, `req.path`, `header()`, `json()` and the injected
 * `_mockStream`; the remaining ~20 `Context` members are unreachable here, so
 * the widening is named once instead of being repeated at 14 call sites.
 */
function makeCtx(
  stream: ReturnType<typeof makeStream>['stream'],
  query: Record<string, string> = {},
): CompileCtx {
  return {
    _mockStream: stream,
    req: {
      query: (k: string) => query[k],
      method: 'POST',
      path: '/compile',
    },
    header: vi.fn(),
    json: (body: unknown, status: number) => Response.json(body, { status }),
  } as unknown as CompileCtx
}

// Override streamSSE to call the callback synchronously with our mock stream
vi.mock('hono/streaming', () => ({
  streamSSE: vi.fn(
    async (c: { _mockStream: ReturnType<typeof makeStream>['stream'] }, cb: (s: unknown) => Promise<void>) => {
      await cb(c._mockStream)
      return new Response()
    },
  ),
}))

const { handleSubprocessCompile } = await import('../routes/spawn-compiler-bridge.js')

// ---------------------------------------------------------------------------

const compileId = 'test-cid-1'

const successLines = [
  JSON.stringify({ type: 'flow:compile_started', compileId, inputKind: 'object' }),
  JSON.stringify({ type: 'flow:compile_parsed', compileId, astNodeType: 'action', errorCount: 0 }),
  JSON.stringify({ type: 'flow:compile_shape_validated', compileId, errorCount: 0 }),
  JSON.stringify({ type: 'flow:compile_semantic_resolved', compileId, resolvedCount: 1, personaCount: 0, errorCount: 0 }),
  JSON.stringify({ type: 'flow:compile_lowered', compileId, target: 'skill-chain', nodeCount: 1, edgeCount: 0, warningCount: 0 }),
  JSON.stringify({ type: 'flow:compile_completed', compileId, target: 'skill-chain', durationMs: 10 }),
  JSON.stringify({
    type: 'result',
    compileId,
    target: 'skill-chain',
    artifact: { steps: [] },
    warnings: [],
    reasons: [{ code: 'SEQUENTIAL_ONLY', message: 'No branching, suspend, or loop features were detected; routed to skill-chain.' }],
  }),
]

describe('SpawnCompilerBridge', () => {
  beforeEach(() => {
    spawnMock.mockClear()
    vi.restoreAllMocks()
  })

  it('returns a sanitized 503 and logs one structured error when spawn fails', async () => {
    const child = new EventEmitter() as ChildMock
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = makeStdin()
    child.kill = vi.fn()
    spawnMock.mockReturnValueOnce(child)
    const spawnError = Object.assign(new Error('spawn node ENOENT: /private/compiler'), {
      code: 'ENOENT',
    })
    setImmediate(() => child.emit('error', spawnError))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const { stream, events } = makeStream()
      const response = await handleSubprocessCompile(
        makeCtx(stream),
        { type: 'action' },
      )

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
      expect(events).toEqual([])
      expect(child.stdin.write).not.toHaveBeenCalled()
      expect(child.listenerCount('error')).toBeGreaterThan(0)
      expect(child.stdin.listenerCount('error')).toBeGreaterThan(0)
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        level: 'error',
        operation: 'compile.subprocess.spawn',
        method: 'POST',
        path: '/compile',
        statusCode: 503,
        error: {
          message: spawnError.message,
          name: 'Error',
          stack: expect.stringContaining('spawn node ENOENT'),
        },
      })
    } finally {
      log.mockRestore()
    }
  })

  it("keeps persistent child and stdin 'error' listeners after spawn succeeds", async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    await handleSubprocessCompile(
      makeCtx(stream),
      { type: 'action', tool: 't' },
    )

    expect(child.listenerCount('error')).toBeGreaterThan(0)
    expect(child.stdin.listenerCount('error')).toBeGreaterThan(0)
  })

  it('forwards lifecycle events and emits flow:compile_result for the final payload', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), { type: 'action', tool: 't' })

    const types = events.map((e) => e.event)
    expect(types).toContain('flow:compile_started')
    expect(types).toContain('flow:compile_lowered')
    expect(types).toContain('flow:compile_completed')
    expect(types[types.length - 1]).toBe('flow:compile_result')

    const resultEvent = events.find((e) => e.event === 'flow:compile_result')
    expect(resultEvent).toBeDefined()
    expect(JSON.parse(resultEvent!.data)).toEqual(buildCompileResultEvent({
      compileId,
      target: 'skill-chain',
      artifact: { steps: [] },
      warnings: [],
      reasons: [{
        code: 'SEQUENTIAL_ONLY',
        message: 'No branching, suspend, or loop features were detected; routed to skill-chain.',
      }],
    }))
  })

  it('maps error line→flow:compile_failed SSE event', async () => {
    const errorLines = [
      JSON.stringify({ type: 'flow:compile_started', compileId, inputKind: 'object' }),
      JSON.stringify({ type: 'error', phase: 'compile', compileId, errors: [{ stage: 2, message: 'bad shape' }] }),
    ]
    const child = makeChild(errorLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), {})

    const failed = events.find((e) => e.event === 'flow:compile_failed')
    expect(failed).toBeDefined()
    expect(JSON.parse(failed!.data)).toMatchObject({ type: 'error' })
  })

  it('writes flow JSON to child stdin and closes it', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), { type: 'action', tool: 't' })

    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'action', tool: 't' }),
      'utf8',
      expect.any(Function),
    )
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('emits a protocol error SSE event for malformed NDJSON', async () => {
    const badLines = [
      JSON.stringify({ type: 'flow:compile_started', compileId, inputKind: 'object' }),
      'NOT_VALID_JSON',
    ]
    const child = makeChild(badLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), {})

    const errorEv = events.find((e) => e.event === 'flow:compile_failed' || e.event === 'error')
    expect(errorEv).toBeDefined()
  })

  it('handles a string flowInput by passing it directly as JSON', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)
    const rawJson = JSON.stringify({ type: 'action', tool: 'myTool' })

    const { stream } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), rawJson)

    expect(child.stdin.write).toHaveBeenCalledWith(rawJson, 'utf8', expect.any(Function))
  })

  it('kills the child when the stream is aborted', async () => {
    // Use a PassThrough that never ends naturally — simulates a stalled child
    const child = makeChild([])
    const pt = new PassThrough()
    child.stdout = pt
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    const ctx = makeCtx(stream)

    // Override onAbort to trigger abort immediately
    ;(stream as { onAbort: (fn: () => void) => void }).onAbort = (fn: () => void) => {
      setImmediate(() => {
        fn()
        // Unblock the generator by ending stdout and emitting close
        pt.push(null)
        setImmediate(() => child.emit('close', 0))
      })
    }

    await handleSubprocessCompile(ctx, { type: 'action' })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('sets X-Run-Id response header when ?runId is provided', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    const ctx = makeCtx(stream, { runId: 'run-123' })
    await handleSubprocessCompile(ctx, { type: 'action', tool: 't' })

    expect(ctx.header).toHaveBeenCalledWith('X-Run-Id', 'run-123')
  })

  it('does not set X-Run-Id response header when ?runId is absent', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    const ctx = makeCtx(stream)
    await handleSubprocessCompile(ctx, { type: 'action', tool: 't' })

    expect(ctx.header).not.toHaveBeenCalledWith('X-Run-Id', expect.anything())
  })

  // -------------------------------------------------------------------------
  // RF-CODE-02 — exit-code gating regression tests
  // -------------------------------------------------------------------------

  /** Build a child that emits NDJSON lines, then closes with the given code/signal. */
  function makeChildWithExit(lines: string[], code: number | null, stderr = '', signal: NodeJS.Signals | null = null): ChildMock {
    const child = new EventEmitter() as ChildMock
    const content = lines.map((l) => `${l}\n`).join('')
    child.stdout = Readable.from(content)
    child.stderr = Readable.from(stderr)
    child.stdin = makeStdin()
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit('close', code, signal))
    })
    const fireClose = (): void => {
      setImmediate(() => child.emit('close', code, signal))
    }
    child.stdout.on('end', fireClose)
    child.stdout.on('close', fireClose)
    setImmediate(() => child.emit('spawn'))
    return child
  }

  it('does NOT emit flow:compile_result when child exits non-zero with a buffered result frame', async () => {
    // Child wrote a complete result line to stdout, but then crashed.
    const child = makeChildWithExit(successLines, 137, 'OOM killed by kernel\n')
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), { type: 'action', tool: 't' })

    const eventTypes = events.map((e) => e.event)
    // Critical: the partial result must NOT be surfaced as success.
    expect(eventTypes).not.toContain('flow:compile_result')
    // It must be reported as a failure instead.
    expect(eventTypes).toContain('flow:compile_failed')

    const failed = events.find((e) => e.event === 'flow:compile_failed')!
    const payload = JSON.parse(failed.data) as { type: string; phase?: string; message?: string; compileId?: string }
    expect(payload.type).toBe('error')
    expect(payload.phase).toBe('subprocess')
    expect(payload.message).toMatch(/code=137/)
    // DZUPAGENT-ERR-H-16: stderr is server-log only.
    expect(failed.data).not.toMatch(/OOM killed by kernel/)
    expect(payload.compileId).toBe(compileId)
    // Note that the discarded partial result is mentioned for diagnosis.
    expect(payload.message).toMatch(/partial result frame discarded/i)
  })

  it('reports a subprocess failure when child exits non-zero without any result frame', async () => {
    const earlyExitLines = [
      JSON.stringify({ type: 'flow:compile_started', compileId, inputKind: 'object' }),
    ]
    const child = makeChildWithExit(earlyExitLines, 1, 'fatal: bad input\n')
    spawnMock.mockReturnValueOnce(child)
    const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), {})

    expect(events.map((e) => e.event)).not.toContain('flow:compile_result')
    const failed = events.find((e) => e.event === 'flow:compile_failed')
    expect(failed).toBeDefined()
    const payload = JSON.parse(failed!.data) as { type: string; phase?: string; message?: string }
    expect(payload.phase).toBe('subprocess')
    expect(payload.message).toMatch(/code=1/)
    expect(failed!.data).not.toMatch(/fatal: bad input/)
    // No partial-result note when there was no buffered result.
    expect(payload.message).not.toMatch(/partial result frame/i)
    // The server log carries the stderr text with the compileId.
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'compile.subprocess.failed',
      phase: 'subprocess',
      compileId,
      detail: 'fatal: bad input',
    }))
  })

  it('reports a subprocess failure when child is killed by a signal (code=null)', async () => {
    const child = makeChildWithExit(successLines, null, 'killed by SIGKILL\n', 'SIGKILL')
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), { type: 'action', tool: 't' })

    expect(events.map((e) => e.event)).not.toContain('flow:compile_result')
    const failed = events.find((e) => e.event === 'flow:compile_failed')
    expect(failed).toBeDefined()
    const payload = JSON.parse(failed!.data) as { type: string; phase?: string; message?: string }
    expect(payload.message).toMatch(/code=null/)
    expect(payload.message).toMatch(/signal=SIGKILL/)
    expect(failed!.data).not.toMatch(/killed by SIGKILL/)
  })

  it('redacts the raw message of a child error frame and logs it with the compileId', async () => {
    const lines = [
      JSON.stringify({ type: 'error', phase: 'compile', compileId, message: 'TypeError at /srv/app/node_modules/x.js:12' }),
    ]
    const child = makeChildWithExit(lines, 0)
    spawnMock.mockReturnValueOnce(child)
    const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), {})

    const failed = events.find((e) => e.event === 'flow:compile_failed')!
    expect(failed.data).not.toMatch(/node_modules|TypeError/)
    expect(JSON.parse(failed.data)).toMatchObject({ type: 'error', phase: 'compile', compileId })
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'compile.subprocess.failed',
      compileId,
      detail: 'TypeError at /srv/app/node_modules/x.js:12',
    }))
  })

  it('projects internal child diagnostics and keeps authored ones', async () => {
    const lines = [
      JSON.stringify({
        type: 'error',
        phase: 'compile',
        compileId,
        errors: [
          { stage: 3, code: 'TOOL_RESOLVER_INFRA_ERROR', message: 'db-7 at 10.0.0.4 timed out', nodePath: 'root' },
          { stage: 2, code: 'MISSING_REQUIRED_FIELD', message: 'bad shape', nodePath: 'root.steps[0]' },
        ],
      }),
    ]
    const child = makeChildWithExit(lines, 0)
    spawnMock.mockReturnValueOnce(child)
    vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), {})

    const failed = events.find((e) => e.event === 'flow:compile_failed')!
    expect(failed.data).not.toMatch(/10\.0\.0\.4/)
    const payload = JSON.parse(failed.data) as { errors: Array<{ code: string; message: string }> }
    expect(payload.errors).toEqual([
      expect.objectContaining({ code: 'TOOL_RESOLVER_INFRA_ERROR', message: expect.stringMatching(/internal error/) }),
      expect.objectContaining({ code: 'MISSING_REQUIRED_FIELD', message: 'bad shape' }),
    ])
  })

  it('does not echo malformed child stdout to the client', async () => {
    const child = makeChild(['SECRET_LOOKING_STDOUT /home/x'])
    spawnMock.mockReturnValueOnce(child)
    vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), {})

    const failed = events.find((e) => e.event === 'flow:compile_failed')!
    expect(JSON.parse(failed.data)).toMatchObject({ phase: 'protocol' })
    expect(failed.data).not.toMatch(/SECRET_LOOKING_STDOUT/)
  })

  it('reports TARGET_MISMATCH instead of a result when the routed target differs', async () => {
    const child = makeChildWithExit(successLines, 0)
    spawnMock.mockReturnValueOnce(child)
    const publish = vi.fn()

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), { type: 'action', tool: 't' }, {
      requestedTarget: 'pipeline',
      eventGateway: { publish } as never,
    })

    expect(events.map((e) => e.event)).not.toContain('flow:compile_result')
    const failed = events.find((e) => e.event === 'flow:compile_failed')!
    expect(JSON.parse(failed.data)).toMatchObject({
      type: 'error',
      compileId,
      errors: [expect.objectContaining({ code: 'TARGET_MISMATCH', stage: 4 })],
    })
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'flow:compile_result' }))
  })

  it('emits the result when the requested target matches', async () => {
    const child = makeChildWithExit(successLines, 0)
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), { type: 'action', tool: 't' }, {
      requestedTarget: 'skill-chain',
    })

    expect(events[events.length - 1]?.event).toBe('flow:compile_result')
  })

  it('persists a success like the in-process branches and never on a mismatch (DZUPAGENT-CODE-M-17)', async () => {
    const appendArtifact = vi.fn().mockResolvedValue(undefined)
    const runEventStore = { appendArtifact } as never

    spawnMock.mockReturnValueOnce(makeChildWithExit(successLines, 0))
    const first = makeStream()
    await handleSubprocessCompile(makeCtx(first.stream, { runId: 'run-sub-1' }), {}, { runEventStore })
    expect(appendArtifact).toHaveBeenCalledTimes(1)
    expect(appendArtifact.mock.calls[0]![0]).toMatchObject({
      runId: 'run-sub-1',
      providerId: 'flow-compiler',
      path: `compile:${compileId}`,
    })

    spawnMock.mockReturnValueOnce(makeChildWithExit(successLines, 0))
    const second = makeStream()
    await handleSubprocessCompile(makeCtx(second.stream), {}, { runEventStore, requestedTarget: 'pipeline' })
    expect(appendArtifact).toHaveBeenCalledTimes(1)
  })

  it('still emits flow:compile_result when child exits cleanly (code=0) — sanity', async () => {
    const child = makeChildWithExit(successLines, 0)
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream), { type: 'action', tool: 't' })

    expect(events.map((e) => e.event)).toContain('flow:compile_result')
    // The buffered result is the last frame emitted.
    expect(events[events.length - 1]?.event).toBe('flow:compile_result')
  })
})
