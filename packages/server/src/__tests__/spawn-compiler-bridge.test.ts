/**
 * SpawnCompilerBridge unit tests.
 *
 * Tests focus on the NDJSON→SSE mapping logic. We mock node:child_process so
 * tests are fast and deterministic. The integration path (real binary) is
 * covered by flow-compiler bin/ smoke tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter, Readable, PassThrough } from 'node:stream'
import { buildCompileResultEvent } from '../routes/compile-result-event.js'

// ---- child_process mock ----------------------------------------------------

type StdinMock = { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
type ChildMock = EventEmitter & {
  stdout: Readable
  stderr: Readable
  stdin: StdinMock
  kill: ReturnType<typeof vi.fn>
}

function makeChild(lines: string[]): ChildMock {
  const child = new EventEmitter() as ChildMock
  const content = lines.map((l) => `${l}\n`).join('')
  child.stdout = Readable.from(content)
  child.stderr = Readable.from('')
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit('close', 0))
  })
  // Emit close when stdout ends OR is destroyed
  const fireClose = (): void => setImmediate(() => child.emit('close', 0))
  child.stdout.on('end', fireClose)
  child.stdout.on('close', fireClose)
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
function makeCtx(
  stream: ReturnType<typeof makeStream>['stream'],
  query: Record<string, string> = {},
): { _mockStream: ReturnType<typeof makeStream>['stream']; req: { query: (k: string) => string | undefined }; header: ReturnType<typeof vi.fn> } {
  return {
    _mockStream: stream,
    req: { query: (k: string) => query[k] },
    header: vi.fn(),
  }
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
  beforeEach(() => { spawnMock.mockClear() })

  it('forwards lifecycle events and emits flow:compile_result for the final payload', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream, events } = makeStream()
    await handleSubprocessCompile(makeCtx(stream) as Parameters<typeof handleSubprocessCompile>[0], { type: 'action', tool: 't' })

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
    await handleSubprocessCompile(makeCtx(stream) as Parameters<typeof handleSubprocessCompile>[0], {})

    const failed = events.find((e) => e.event === 'flow:compile_failed')
    expect(failed).toBeDefined()
    expect(JSON.parse(failed!.data)).toMatchObject({ type: 'error' })
  })

  it('writes flow JSON to child stdin and closes it', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    await handleSubprocessCompile(makeCtx(stream) as Parameters<typeof handleSubprocessCompile>[0], { type: 'action', tool: 't' })

    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'action', tool: 't' }),
      'utf8',
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
    await handleSubprocessCompile(makeCtx(stream) as Parameters<typeof handleSubprocessCompile>[0], {})

    const errorEv = events.find((e) => e.event === 'flow:compile_failed' || e.event === 'error')
    expect(errorEv).toBeDefined()
  })

  it('handles a string flowInput by passing it directly as JSON', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)
    const rawJson = JSON.stringify({ type: 'action', tool: 'myTool' })

    const { stream } = makeStream()
    await handleSubprocessCompile(makeCtx(stream) as Parameters<typeof handleSubprocessCompile>[0], rawJson)

    expect(child.stdin.write).toHaveBeenCalledWith(rawJson, 'utf8')
  })

  it('kills the child when the stream is aborted', async () => {
    // Use a PassThrough that never ends naturally — simulates a stalled child
    const child = makeChild([])
    const pt = new PassThrough()
    child.stdout = pt
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    const ctx = makeCtx(stream) as Parameters<typeof handleSubprocessCompile>[0]

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
    await handleSubprocessCompile(ctx as unknown as Parameters<typeof handleSubprocessCompile>[0], { type: 'action', tool: 't' })

    expect(ctx.header).toHaveBeenCalledWith('X-Run-Id', 'run-123')
  })

  it('does not set X-Run-Id response header when ?runId is absent', async () => {
    const child = makeChild(successLines)
    spawnMock.mockReturnValueOnce(child)

    const { stream } = makeStream()
    const ctx = makeCtx(stream)
    await handleSubprocessCompile(ctx as unknown as Parameters<typeof handleSubprocessCompile>[0], { type: 'action', tool: 't' })

    expect(ctx.header).not.toHaveBeenCalledWith('X-Run-Id', expect.anything())
  })
})
