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
const mockCreateFlowCompiler = vi.fn(() => ({ compile: mockCompile }))

vi.mock('@dzupagent/flow-compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof FlowCompilerModule>()
  return {
    ...actual,
    createFlowCompiler: (...args: unknown[]) => mockCreateFlowCompiler(...args),
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
