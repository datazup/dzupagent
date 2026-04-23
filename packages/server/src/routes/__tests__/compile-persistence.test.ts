/**
 * Tests for RunEventStore persistence in POST /compile.
 *
 * Scenarios:
 *  JSON branch:
 *   1. No runEventStore configured — no error, normal JSON response.
 *   2. Successful compile — appendArtifact called once with correct compileId.
 *   3. Failed compile (compiler returns errors) — store NOT called.
 *  SSE branch:
 *   4. Successful SSE compile — appendArtifact called after terminal event.
 *   5. Failed SSE compile (compiler returns errors) — store NOT called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createCompileRoutes } from '../compile.js'
import type { RunEventStore } from '@dzupagent/agent-adapters'

// ---------------------------------------------------------------------------
// Mock flow-compiler
// ---------------------------------------------------------------------------

const mockCompile = vi.fn()

// mockCreateFlowCompiler allows SSE tests to capture the eventBus option
// injected by the SSE branch so they can emit synthetic lifecycle events.
const mockCreateFlowCompiler = vi.fn(() => ({ compile: mockCompile }))

vi.mock('@dzupagent/flow-compiler', () => ({
  createFlowCompiler: (...args: unknown[]) => mockCreateFlowCompiler(...args),
}))

// Mock spawn-compiler-bridge so we don't spin up subprocesses
vi.mock('../spawn-compiler-bridge.js', () => ({
  handleSubprocessCompile: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(runEventStore?: RunEventStore): Hono {
  const app = new Hono()
  app.route('/api/workflows', createCompileRoutes({ runEventStore }))
  return app
}

async function postCompile(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/workflows/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeFlowBody() {
  return { flow: { id: 'flow-1', steps: [] } }
}

/** Minimal RunEventStore mock with a spy on appendArtifact. */
function makeMockStore(): RunEventStore {
  return {
    appendArtifact: vi.fn().mockResolvedValue(undefined),
    appendRaw: vi.fn().mockResolvedValue(undefined),
    appendNormalized: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as RunEventStore
}

const SUCCESS_RESULT = {
  artifact: { id: 'sc-1', steps: [] },
  warnings: [],
  target: 'skill-chain' as const,
  compileId: 'cid-test-42',
}

const FAILURE_RESULT = {
  errors: [{ stage: 1 as const, message: 'parse error' }],
  compileId: 'cid-fail-99',
}

// ---------------------------------------------------------------------------
// SSE helpers (mirrors compile-routes.test.ts)
// ---------------------------------------------------------------------------

async function postCompileSSE(
  app: Hono,
  body: unknown,
  queryParams?: Record<string, string>,
): Promise<Response> {
  const qs = queryParams ? '?' + new URLSearchParams(queryParams).toString() : ''
  return app.request(`/api/workflows/compile${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  })
}

async function drainSSE(response: Response, timeoutMs = 3000): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ])
      if (result.done) break
      raw += decoder.decode(result.value, { stream: true })
      if (
        raw.includes('event: flow:compile_completed') ||
        raw.includes('event: flow:compile_failed') ||
        raw.includes('event: error')
      ) {
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return raw
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compile route — RunEventStore persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset to default: return { compile: mockCompile }
    mockCreateFlowCompiler.mockImplementation(() => ({ compile: mockCompile }))
  })

  it('works normally when no runEventStore is configured', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)

    const app = buildApp(/* no store */)
    const res = await postCompile(app, makeFlowBody())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.compileId).toBe(SUCCESS_RESULT.compileId)
    expect(json.target).toBe('skill-chain')
  })

  it('calls appendArtifact once with the correct compileId on success', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)

    const store = makeMockStore()
    const app = buildApp(store)
    const res = await postCompile(app, makeFlowBody())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.compileId).toBe(SUCCESS_RESULT.compileId)

    // Allow the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 0))

    expect(store.appendArtifact).toHaveBeenCalledTimes(1)
    const [call] = (store.appendArtifact as ReturnType<typeof vi.fn>).mock.calls
    const event = call[0] as Parameters<RunEventStore['appendArtifact']>[0]

    expect(event.runId).toBe(SUCCESS_RESULT.compileId)
    expect(event.action).toBe('created')
    expect(event.artifactType).toBe('output')
    expect(event.path).toBe(`compile:${SUCCESS_RESULT.compileId}`)
    expect(event.metadata?.type).toBe('compile:completed')
    expect(event.metadata?.target).toBe('skill-chain')
  })

  it('does NOT call appendArtifact when the compile fails', async () => {
    mockCompile.mockResolvedValueOnce(FAILURE_RESULT)

    const store = makeMockStore()
    const app = buildApp(store)
    const res = await postCompile(app, makeFlowBody())

    // Compiler failure → 400
    expect(res.status).toBe(400)

    await new Promise((r) => setTimeout(r, 0))

    expect(store.appendArtifact).not.toHaveBeenCalled()
  })

  it('JSON branch: uses caller-supplied ?runId when provided', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)

    const store = makeMockStore()
    const app = buildApp(store)

    // Supply ?runId=caller-run-42 as a query param on the JSON branch.
    const res = await app.request('/api/workflows/compile?runId=caller-run-42', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeFlowBody()),
    })

    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 0))

    expect(store.appendArtifact).toHaveBeenCalledTimes(1)
    const [call] = (store.appendArtifact as ReturnType<typeof vi.fn>).mock.calls
    const event = call[0] as Parameters<RunEventStore['appendArtifact']>[0]

    expect(event.runId).toBe('caller-run-42')
    // path should still be keyed on compileId, not the caller runId
    expect(event.path).toBe(`compile:${SUCCESS_RESULT.compileId}`)
  })

  it('JSON branch: falls back to compileId when ?runId is absent', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)

    const store = makeMockStore()
    const app = buildApp(store)
    const res = await postCompile(app, makeFlowBody())

    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 0))

    expect(store.appendArtifact).toHaveBeenCalledTimes(1)
    const [call] = (store.appendArtifact as ReturnType<typeof vi.fn>).mock.calls
    const event = call[0] as Parameters<RunEventStore['appendArtifact']>[0]

    // No ?runId supplied — must fall back to result.compileId.
    expect(event.runId).toBe(SUCCESS_RESULT.compileId)
    expect(event.path).toBe(`compile:${SUCCESS_RESULT.compileId}`)
  })

  // -------------------------------------------------------------------------
  // SSE branch — persistence
  // -------------------------------------------------------------------------

  it('SSE branch: calls appendArtifact once with correct runId on success', async () => {
    // Capture the eventBus injected into the compiler so we can emit synthetic
    // lifecycle events that drive the SSE drain loop to completion.
    let capturedBus: { emit: (e: unknown) => void } | null = null
    const TEST_RUN_ID = 'run-sse-42'

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              capturedBus.emit({
                type: 'flow:compile_started',
                compileId: SUCCESS_RESULT.compileId,
                inputKind: 'object',
              })
              capturedBus.emit({
                type: 'flow:compile_completed',
                compileId: SUCCESS_RESULT.compileId,
                target: SUCCESS_RESULT.target,
                durationMs: 5,
              })
            }
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const store = makeMockStore()
    const app = buildApp(store)
    // Pass runId as a query param so persistence is triggered.
    const res = await postCompileSSE(app, makeFlowBody(), { runId: TEST_RUN_ID })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Drain the stream to let the SSE branch reach the persistence call.
    await drainSSE(res)

    // Allow fire-and-forget promise to settle.
    await new Promise((r) => setTimeout(r, 10))

    expect(store.appendArtifact).toHaveBeenCalledTimes(1)
    const [call] = (store.appendArtifact as ReturnType<typeof vi.fn>).mock.calls
    const event = call[0] as Parameters<RunEventStore['appendArtifact']>[0]

    expect(event.runId).toBe(TEST_RUN_ID)
    expect(event.action).toBe('created')
    expect(event.artifactType).toBe('output')
    expect(event.path).toBe(`compile:${SUCCESS_RESULT.compileId}`)
    expect(event.metadata?.type).toBe('compile:completed')
    expect(event.metadata?.target).toBe('skill-chain')
  })

  it('SSE branch: does NOT call appendArtifact when compiler returns errors', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              capturedBus.emit({
                type: 'flow:compile_started',
                compileId: FAILURE_RESULT.compileId,
                inputKind: 'object',
              })
              capturedBus.emit({
                type: 'flow:compile_failed',
                compileId: FAILURE_RESULT.compileId,
                stage: 1,
                errorCount: 1,
                durationMs: 2,
              })
            }
            return FAILURE_RESULT
          }),
        }
      },
    )

    const store = makeMockStore()
    const app = buildApp(store)
    const res = await postCompileSSE(app, makeFlowBody())

    // SSE always returns 200 for the HTTP response; errors are in the stream.
    expect(res.status).toBe(200)

    await drainSSE(res)
    await new Promise((r) => setTimeout(r, 10))

    // FAILURE_RESULT has 'errors' in result — persistence guard skips the call.
    expect(store.appendArtifact).not.toHaveBeenCalled()
  })

  it('SSE branch: does NOT call appendArtifact when runId query param is missing', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              capturedBus.emit({
                type: 'flow:compile_started',
                compileId: SUCCESS_RESULT.compileId,
                inputKind: 'object',
              })
              capturedBus.emit({
                type: 'flow:compile_completed',
                compileId: SUCCESS_RESULT.compileId,
                target: SUCCESS_RESULT.target,
                durationMs: 5,
              })
            }
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const store = makeMockStore()
    const app = buildApp(store)
    // No runId in query params — persistence must be skipped.
    const res = await postCompileSSE(app, makeFlowBody())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    await drainSSE(res)
    await new Promise((r) => setTimeout(r, 10))

    // Guard: runId is missing so appendArtifact must NOT be called even though
    // the compile succeeded and a runEventStore is configured.
    expect(store.appendArtifact).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SSE compile — X-Run-Id response header
// ---------------------------------------------------------------------------

describe('SSE compile — X-Run-Id response header', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateFlowCompiler.mockImplementation(() => ({ compile: mockCompile }))
  })

  it('sets X-Run-Id header when runId query param is provided', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              capturedBus.emit({
                type: 'flow:compile_started',
                compileId: SUCCESS_RESULT.compileId,
                inputKind: 'object',
              })
              capturedBus.emit({
                type: 'flow:compile_completed',
                compileId: SUCCESS_RESULT.compileId,
                target: SUCCESS_RESULT.target,
                durationMs: 5,
              })
            }
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const app = buildApp()
    const res = await postCompileSSE(app, makeFlowBody(), { runId: 'run-abc-123' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('X-Run-Id')).toBe('run-abc-123')

    await drainSSE(res)
  })

  it('does not set X-Run-Id header when runId is absent', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              capturedBus.emit({
                type: 'flow:compile_started',
                compileId: SUCCESS_RESULT.compileId,
                inputKind: 'object',
              })
              capturedBus.emit({
                type: 'flow:compile_completed',
                compileId: SUCCESS_RESULT.compileId,
                target: SUCCESS_RESULT.target,
                durationMs: 5,
              })
            }
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const app = buildApp()
    // No runId — header must be absent.
    const res = await postCompileSSE(app, makeFlowBody())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('X-Run-Id')).toBeNull()

    await drainSSE(res)
  })
})
