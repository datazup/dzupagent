/**
 * H5: tests for the `?stream=true` SSE variant of POST /api/workflows/compile.
 *
 * Three minimal checks:
 *   1. `?stream=true` returns a `text/event-stream` response.
 *   2. The SSE body contains a terminal `event: result` line on success.
 *   3. Without `?stream=true`, the response is unchanged JSON.
 *
 * `@dzupagent/flow-compiler` is mocked so no real compiler runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type * as FlowCompilerModule from '@dzupagent/flow-compiler'
import { createCompileRoutes } from '../routes/compile.js'

// ---------------------------------------------------------------------------
// Mock flow-compiler
// ---------------------------------------------------------------------------

const mockCompile = vi.fn()
/**
 * The real `createFlowCompiler` takes exactly one `CompilerOptions` argument.
 * Declaring it here — rather than leaving `vi.fn()` at zero parameters — is
 * what lets `mock.calls[n]` be a tuple and `mockImplementationOnce` accept a
 * callback that reads `cfg.eventBus`.
 */
type FlowCompilerOptions = Parameters<
  typeof FlowCompilerModule.createFlowCompiler
>[0]

const mockCreateFlowCompiler = vi.fn((_opts: FlowCompilerOptions) => ({
  compile: mockCompile,
}))

vi.mock('@dzupagent/flow-compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof FlowCompilerModule>()
  return {
    ...actual,
    createFlowCompiler: (opts: FlowCompilerOptions) => mockCreateFlowCompiler(opts),
  }
})

// Avoid spawning real subprocesses if a future test toggles ?subprocess=true.
vi.mock('../routes/spawn-compiler-bridge.js', () => ({
  handleSubprocessCompile: vi.fn(),
}))

const SUCCESS_RESULT = {
  artifact: { id: 'sc-1', steps: [] },
  warnings: [],
  reasons: [],
  target: 'skill-chain' as const,
  compileId: 'cid-stream-1',
}

function buildApp(): Hono {
  const app = new Hono()
  app.route('/api/workflows', createCompileRoutes({}))
  return app
}

async function postCompile(app: Hono, body: unknown, query = ''): Promise<Response> {
  return app.request(`/api/workflows/compile${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Drain an SSE response body to a single string, with a small timeout. */
async function readSSEBody(res: Response, timeoutMs = 2000): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let raw = ''
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
      // Stop early once the terminal `result` or `error` event arrives so the
      // test does not idle until the deadline.
      if (raw.includes('event: result') || raw.includes('event: error')) {
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return raw
}

describe('POST /api/workflows/compile — ?stream=true (H5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('?stream=true returns text/event-stream content-type', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const res = await postCompile(
      app,
      { flow: { type: 'action', tool: 'myTool' } },
      '?stream=true',
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Drain so the response body can settle (vitest otherwise warns about
    // unconsumed streams in some environments).
    await readSSEBody(res)
  })

  it('?stream=true SSE body contains a terminal `event: result` on success', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const res = await postCompile(
      app,
      { flow: { type: 'action', tool: 'myTool' } },
      '?stream=true',
    )

    const body = await readSSEBody(res)
    expect(body).toContain('event: result')
    // The result payload is JSON-encoded after `data: ` — confirm the compileId
    // round-trips so we know the artifact is actually serialised.
    expect(body).toContain('"compileId":"cid-stream-1"')
  })

  it('without ?stream=true, response is unchanged JSON', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const res = await postCompile(app, { flow: { type: 'action', tool: 'myTool' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')

    const json = (await res.json()) as {
      ok: boolean
      compileId: string
      target: string
    }
    expect(json.ok).toBe(true)
    expect(json.compileId).toBe('cid-stream-1')
    expect(json.target).toBe('skill-chain')
  })
})

// ---------------------------------------------------------------------------
// DZUPAGENT-ERR-H-02: infrastructure diagnostics never reach SSE clients.
// ---------------------------------------------------------------------------

describe('POST /api/workflows/compile?stream=true — internal diagnostic redaction (DZUPAGENT-ERR-H-02)', () => {
  const MARKER = 'INFRA-MARKER-77c0 replica db-7 timed out'
  const PUBLIC = 'Compilation could not complete because of an internal error'
  const FLOW = { type: 'sequence', nodes: [{ type: 'action', toolRef: 'pm.create_task', input: {} }] }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function buildResolverApp(resolve: () => unknown): Hono {
    const app = new Hono()
    app.route(
      '/api/workflows',
      createCompileRoutes({ toolResolver: { resolve: resolve as never, listAvailable: () => [] } }),
    )
    return app
  }

  async function useRealCompiler(): Promise<void> {
    const actual = await vi.importActual<typeof FlowCompilerModule>('@dzupagent/flow-compiler')
    mockCreateFlowCompiler.mockImplementationOnce(
      (opts) => actual.createFlowCompiler(opts) as unknown as ReturnType<typeof mockCreateFlowCompiler>,
    )
  }

  function errorEvent(body: string): { message: string; stage: string; compileId?: string } {
    const match = /event: error\ndata: (.*)\n/.exec(body)
    expect(match).not.toBeNull()
    return JSON.parse(match![1]!) as { message: string; stage: string; compileId?: string }
  }

  it('a configured resolver failure streams a fixed public error event', async () => {
    await useRealCompiler()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = buildResolverApp(async () => {
      throw new Error(`${MARKER}. Did you mean: "${MARKER}"`)
    })

    const res = await postCompile(app, { flow: FLOW }, '?stream=true')
    const body = await readSSEBody(res)

    expect(body).not.toContain('INFRA-MARKER')
    const event = errorEvent(body)
    expect(event.message).toBe(PUBLIC)
    expect(event.stage).toBe('lower')
    expect(typeof event.compileId).toBe('string')
    const logged = consoleError.mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('INFRA-MARKER') && line.includes(event.compileId!))).toBe(true)
  })

  it('a returned internal diagnostic streams the fixed public message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCompile.mockResolvedValueOnce({
      errors: [
        {
          stage: 3,
          code: 'RESOLVER_INFRA_ERROR',
          category: 'internal',
          nodePath: 'root.nodes[0]',
          message: MARKER,
          suggestion: MARKER,
        },
      ],
      compileId: 'cid-stream-infra',
    })
    const app = buildApp()

    const res = await postCompile(app, { flow: FLOW }, '?stream=true')
    const body = await readSSEBody(res)

    expect(body).not.toContain('INFRA-MARKER')
    expect(errorEvent(body)).toEqual({ message: PUBLIC, stage: 'lower', compileId: 'cid-stream-infra' })
  })

  it('authored validation diagnostics keep their message on the error event', async () => {
    mockCompile.mockResolvedValueOnce({
      errors: [
        {
          stage: 3,
          code: 'UNRESOLVED_TOOL_REF',
          category: 'resolution',
          nodePath: 'root.nodes[0]',
          message: 'Unresolved tool reference "pm.create_task"',
        },
      ],
      compileId: 'cid-stream-auth',
    })
    const app = buildApp()

    const res = await postCompile(app, { flow: FLOW }, '?stream=true')
    const body = await readSSEBody(res)

    expect(errorEvent(body).message).toBe('Unresolved tool reference "pm.create_task"')
  })
})
