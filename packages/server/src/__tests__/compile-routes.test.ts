/**
 * HTTP route tests for POST /api/workflows/compile
 *
 * Tests cover:
 *  - JSON branch: success, validation errors, target mismatch, compiler failure
 *  - SSE in-process branch: lifecycle events streamed as SSE
 *  - Subprocess SSE branch: delegates to handleSubprocessCompile (mocked)
 *
 * No live compiler or child processes are used — flow-compiler is mocked so
 * that compile() returns predetermined results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { DzupEvent } from '@dzupagent/core'
import type * as FlowCompilerModule from '@dzupagent/flow-compiler'
import { createCompileRoutes } from '../routes/compile.js'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { InMemoryEventGateway } from '../events/event-gateway.js'
import { InMemoryPersonaStore } from '../personas/persona-store.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildApp(overrides?: Parameters<typeof createCompileRoutes>[0]): Hono {
  const app = new Hono()
  app.route('/api/workflows', createCompileRoutes(overrides ?? {}))
  return app
}

async function postCompile(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/api/workflows/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class MockWsClient implements WSClient {
  readyState = 1
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
}

function parseEventTypes(ws: MockWsClient): string[] {
  return ws.sent
    .map((raw) => JSON.parse(raw) as { type?: string })
    .map((message) => message.type)
    .filter((type): type is string => typeof type === 'string')
}

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

// Mock handleSubprocessCompile so the subprocess branch does not spawn a real process
const mockHandleSubprocessCompile = vi.fn(async (_c: unknown, _flow: unknown) => {
  return new Response(
    'event: flow:compile_completed\ndata: {"type":"flow:compile_completed"}\n\n',
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )
})

vi.mock('../routes/spawn-compiler-bridge.js', () => ({
  handleSubprocessCompile: (...args: unknown[]) =>
    mockHandleSubprocessCompile(...args),
}))

// ---------------------------------------------------------------------------
// Typical success artifact from the compiler
// ---------------------------------------------------------------------------

const SKILL_CHAIN_ARTIFACT = {
  id: 'sc-1',
  steps: [{ id: 's1', tool: 'myTool' }],
}

const SUCCESS_RESULT = {
  artifact: SKILL_CHAIN_ARTIFACT,
  warnings: [],
  reasons: [{ code: 'SEQUENTIAL_ONLY', message: 'No branching, suspend, or loop features were detected; routed to skill-chain.' }],
  target: 'skill-chain' as const,
  compileId: 'cid-abc-123',
}

// ---------------------------------------------------------------------------
// JSON branch
// ---------------------------------------------------------------------------

describe('POST /api/workflows/compile — JSON branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('200 — success with valid flow object', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const res = await postCompile(app, { flow: { type: 'action', tool: 'myTool' } })
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      ok: boolean
      artifact: unknown
      warnings: unknown[]
      reasons: unknown[]
      target: string
      compileId: string
    }
    expect(body.ok).toBe(true)
    expect(body.artifact).toEqual(SKILL_CHAIN_ARTIFACT)
    expect(body.target).toBe('skill-chain')
    expect(body.compileId).toBe('cid-abc-123')
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(Array.isArray(body.reasons)).toBe(true)
  })

  it('200 — success with valid flow JSON string', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const res = await postCompile(app, {
      flow: JSON.stringify({ type: 'action', tool: 'myTool' }),
    })
    expect(res.status).toBe(200)
  })

  it('200 — passes toolResolver from config to compiler', async () => {
    const toolResolver = {
      resolve: vi.fn().mockReturnValue(null),
      listAvailable: vi.fn().mockReturnValue([]),
    }
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp({ toolResolver })

    await postCompile(app, { flow: { type: 'action', tool: 'myTool' } })

    expect(mockCreateFlowCompiler).toHaveBeenCalledWith(
      expect.objectContaining({ toolResolver }),
    )
  })

  it('200 — derives personaResolver from personaStore when explicit resolver is omitted', async () => {
    const personaStore = new InMemoryPersonaStore()
    await personaStore.save({
      id: 'planner',
      name: 'Planner',
      instructions: 'Plan the work',
    })

    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp({ personaStore })

    const res = await postCompile(app, { flow: { type: 'action', tool: 'myTool' } })
    expect(res.status).toBe(200)

    const lastCall = mockCreateFlowCompiler.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const constructorArg = (lastCall as unknown[])[0] as {
      personaResolver?: { resolve: (ref: string) => unknown }
    }
    expect(constructorArg.personaResolver).toBeDefined()
    expect(typeof constructorArg.personaResolver?.resolve).toBe('function')
  })

  it('200 — explicit personaResolver takes precedence over personaStore', async () => {
    const personaStore = new InMemoryPersonaStore()
    await personaStore.save({
      id: 'planner',
      name: 'Planner',
      instructions: 'Plan the work',
    })
    const personaResolver = { resolve: vi.fn().mockReturnValue(true) }

    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp({ personaStore, personaResolver })

    const res = await postCompile(app, { flow: { type: 'action', tool: 'myTool' } })
    expect(res.status).toBe(200)

    const lastCall = mockCreateFlowCompiler.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const constructorArg = (lastCall as unknown[])[0] as { personaResolver?: unknown }
    expect(constructorArg.personaResolver).toBe(personaResolver)
  })

  it('publishes compile lifecycle progress and final result to shared subscribers when eventGateway is configured', async () => {
    let capturedBus: { emit: (e: DzupEvent) => void } | undefined
    const gateway = new InMemoryEventGateway()
    const bridge = new EventBridge(gateway)
    const ws = new MockWsClient()
    bridge.addClient(ws, {
      eventTypes: [
        'flow:compile_started',
        'flow:compile_completed',
        'flow:compile_result',
      ],
    })

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            capturedBus?.emit({ type: 'flow:compile_started', compileId: 'cid-abc-123', inputKind: 'object' })
            capturedBus?.emit({ type: 'flow:compile_completed', compileId: 'cid-abc-123', target: 'skill-chain', durationMs: 20 })
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const app = buildApp({ eventGateway: gateway })
    const res = await postCompile(app, { flow: { type: 'action', tool: 'myTool' } })
    expect(res.status).toBe(200)

    await drain()
    expect(parseEventTypes(ws)).toEqual([
      'flow:compile_started',
      'flow:compile_completed',
      'flow:compile_result',
    ])
  })

  it('400 — returns error with stage when compiler returns errors', async () => {
    mockCompile.mockResolvedValueOnce({
      errors: [{ stage: 2, code: 'MISSING_REQUIRED_FIELD', message: 'Invalid shape: missing required field' }],
      compileId: 'cid-fail-1',
    })
    const app = buildApp()

    const res = await postCompile(app, { flow: { type: 'bad-node' } })
    expect(res.status).toBe(400)

    const body = (await res.json()) as {
      ok: boolean
      error: string
      stage: number
      errors: Array<{ code?: string }>
      compileId: string
    }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('Invalid shape')
    expect(body.stage).toBe(2)
    expect(Array.isArray(body.errors)).toBe(true)
    expect(body.errors[0]?.code).toBe('MISSING_REQUIRED_FIELD')
    expect(body.compileId).toBe('cid-fail-1')
  })

  it('400 — returns error when flow field is missing', async () => {
    const app = buildApp()

    const res = await postCompile(app, { target: 'skill-chain' })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok: boolean; error: string; stage: number; errors: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/one of "flow", "document", or "dsl" is required/)
    expect(body.stage).toBe(1)
    expect(body.errors[0]?.code).toBe('MISSING_REQUIRED_FIELD')
  })

  it('200 — accepts canonical workflow document input and compiles document.root', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const document = {
      dsl: 'dzupflow/v1',
      id: 'doc_flow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'complete', id: 'done', result: 'ok' },
        ],
      },
    }

    const res = await postCompile(app, { document })
    expect(res.status).toBe(200)
    expect(mockCompile).toHaveBeenCalledWith(document.root)
  })

  it('200 — accepts dzupflow DSL input and compiles the normalized root flow', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const res = await postCompile(app, {
      dsl: `
dsl: dzupflow/v1
id: review_and_build
version: 1
steps:
  - complete:
      id: done
      result: ok
`,
    })
    expect(res.status).toBe(200)
    expect(mockCompile).toHaveBeenCalledWith({
      type: 'sequence',
      id: 'root',
      nodes: [
        { type: 'complete', id: 'done', result: 'ok' },
      ],
    })
  })

  it('400 — rejects requests that provide more than one compile input', async () => {
    const app = buildApp()

    const res = await postCompile(app, {
      flow: { type: 'action', tool: 't' },
      dsl: 'dsl: dzupflow/v1',
    })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok: boolean; errors: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect(body.errors[0]?.code).toBe('INVALID_REQUEST')
  })

  it('400 — returns error when flow is null', async () => {
    const app = buildApp()

    const res = await postCompile(app, { flow: null })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/one of "flow", "document", or "dsl" is required/)
  })

  it('400 — returns error for invalid JSON body', async () => {
    const app = buildApp()

    const res = await app.request('/api/workflows/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'THIS IS NOT JSON',
    })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok: boolean; error: string; stage: number; errors: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/Invalid JSON/i)
    expect(body.stage).toBe(1)
    expect(body.errors[0]?.code).toBe('INVALID_REQUEST')
  })

  it('400 — returns error when flow is a number (invalid primitive)', async () => {
    const app = buildApp()

    const res = await postCompile(app, { flow: 42 })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok: boolean; error: string; stage: number; errors: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/string or object/)
    expect(body.stage).toBe(1)
    expect(body.errors[0]?.code).toBe('INVALID_REQUEST')
  })

  it('400 — returns error for invalid target value', async () => {
    const app = buildApp()

    const res = await postCompile(app, {
      flow: { type: 'action', tool: 't' },
      target: 'not-a-valid-target',
    })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok: boolean; error: string; stage: number; errors: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/target must be one of/)
    expect(body.stage).toBe(1)
    expect(body.errors[0]?.code).toBe('INVALID_ENUM_VALUE')
  })

  it('400 — returns error when requested target mismatches compiler-routed target', async () => {
    mockCompile.mockResolvedValueOnce({
      ...SUCCESS_RESULT,
      target: 'pipeline' as const, // compiler chose pipeline
    })
    const app = buildApp()

    const res = await postCompile(app, {
      flow: { type: 'action', tool: 't' },
      target: 'skill-chain', // caller requested skill-chain
    })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok: boolean; error: string; stage: number; compileId: string; errors: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/does not match compiler-routed target/)
    expect(body.stage).toBe(4)
    expect(body.errors[0]?.code).toBe('TARGET_MISMATCH')
    expect(body.compileId).toBe('cid-abc-123')
  })

  it('200 — target assertion passes when target matches compiler output', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT) // target: 'skill-chain'
    const app = buildApp()

    const res = await postCompile(app, {
      flow: { type: 'action', tool: 't' },
      target: 'skill-chain',
    })
    expect(res.status).toBe(200)
  })

  it('500 — returns internal error when compiler throws', async () => {
    mockCompile.mockRejectedValueOnce(new Error('Unexpected compiler panic'))
    const app = buildApp()

    const res = await postCompile(app, { flow: { type: 'action', tool: 't' } })
    expect(res.status).toBe(500)

    const body = (await res.json()) as { ok: boolean; error: string; stage: number; errors: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect(body.stage).toBe(1)
    // sanitizeError strips internal error message from external response
    expect(typeof body.error).toBe('string')
    expect(body.errors[0]?.code).toBe('INTERNAL_ERROR')
  })

  it('200 — all three valid target values are accepted', async () => {
    const targets = ['skill-chain', 'workflow-builder', 'pipeline'] as const
    for (const target of targets) {
      mockCompile.mockResolvedValueOnce({
        ...SUCCESS_RESULT,
        target,
      })
      const app = buildApp()
      const res = await postCompile(app, {
        flow: { type: 'action', tool: 't' },
        target,
      })
      expect(res.status).toBe(200)
    }
  })

  it('200 — omitting target skips target assertion', async () => {
    mockCompile.mockResolvedValueOnce({
      ...SUCCESS_RESULT,
      target: 'workflow-builder' as const,
    })
    const app = buildApp()

    const res = await postCompile(app, { flow: { type: 'workflow', steps: [] } })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { target: string }
    expect(body.target).toBe('workflow-builder')
  })

  it('200 — warnings array included in response', async () => {
    mockCompile.mockResolvedValueOnce({
      ...SUCCESS_RESULT,
      warnings: [{ message: 'Deprecated field used' }],
    })
    const app = buildApp()

    const res = await postCompile(app, { flow: { type: 'action', tool: 't' } })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { warnings: Array<{ message: string }> }
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0]?.message).toBe('Deprecated field used')
  })

  it('400 — multiple errors: first error stage determines status-body stage', async () => {
    mockCompile.mockResolvedValueOnce({
      errors: [
        { stage: 3, code: 'UNRESOLVED_TOOL_REF', message: 'Unresolved tool ref: badTool' },
        { stage: 3, code: 'UNRESOLVED_TOOL_REF', message: 'Unresolved tool ref: anotherTool' },
      ],
      compileId: 'cid-multi-err',
    })
    const app = buildApp()

    const res = await postCompile(app, { flow: { type: 'action', tool: 'badTool' } })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok: boolean; error: string; errors: Array<{ code?: string }>; stage: number }
    expect(body.ok).toBe(false)
    expect(body.stage).toBe(3)
    expect(body.errors).toHaveLength(2)
    expect(body.error).toContain('Unresolved tool ref')
    expect(body.errors.every((error) => error.code === 'UNRESOLVED_TOOL_REF')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SSE in-process branch
// ---------------------------------------------------------------------------

/**
 * Reads raw SSE text from a streaming response body.
 */
async function readSSERaw(
  response: Response,
  timeoutMs = 3000,
  terminalEvent: 'flow:compile_result' | 'flow:compile_failed' | 'error' | 'flow:compile_completed' = 'flow:compile_completed',
): Promise<string> {
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
      if (raw.includes(`event: ${terminalEvent}`)) {
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  return raw
}

/** Parse SSE text into {event, data} pairs. */
function parseSSEPairs(raw: string): Array<{ event: string; data: string }> {
  const pairs: Array<{ event: string; data: string }> = []
  let event = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      event = line.slice(7).trim()
    } else if (line.startsWith('data: ') && event) {
      pairs.push({ event, data: line.slice(6) })
      event = ''
    }
  }
  return pairs
}

describe('POST /api/workflows/compile — SSE in-process branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('200 — response is text/event-stream when Accept header is text/event-stream', async () => {
    // Compile resolves immediately — the SSE branch uses createEventBus, so the
    // compiler must emit events. We simulate this by making compile resolve
    // synchronously with a success result. The bus emits flow:compile_completed
    // before the stream closes.
    mockCompile.mockImplementationOnce(async () => {
      // Emit nothing — but bus.onAny subscription awaits wake. Return immediately.
      return SUCCESS_RESULT
    })

    const app = buildApp()
    const res = await postCompile(app, { flow: { type: 'action', tool: 't' } }, {
      Accept: 'text/event-stream',
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  it('SSE stream contains valid JSON in data fields', async () => {
    // The compile should emit events via the bus. Since we mock createFlowCompiler,
    // the bus will not have events emitted. We need to make the compile function
    // also simulate terminal event via the captured bus.
    //
    // Strategy: intercept createFlowCompiler, capture the bus, emit events manually.
    let capturedBus: { onAny: (fn: (e: unknown) => void) => () => void; emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            // Emit lifecycle events into the bus before returning
            if (capturedBus) {
              capturedBus.emit({ type: 'flow:compile_started', compileId: 'c1', inputKind: 'object' })
              capturedBus.emit({ type: 'flow:compile_completed', compileId: 'c1', target: 'skill-chain', durationMs: 10 })
            }
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const app = buildApp()
    const res = await postCompile(
      app,
      { flow: { type: 'action', tool: 't' } },
      { Accept: 'text/event-stream' },
    )

    const raw = await readSSERaw(res, 3000, 'flow:compile_result')
    const pairs = parseSSEPairs(raw)

    // Every data field must be valid JSON
    for (const pair of pairs) {
      expect(() => JSON.parse(pair.data), `expected valid JSON for event ${pair.event}: ${pair.data}`).not.toThrow()
    }
  })

  it('SSE stream emits lifecycle events plus a final flow:compile_result payload', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              capturedBus.emit({ type: 'flow:compile_started', compileId: 'c2', inputKind: 'object' })
              capturedBus.emit({ type: 'flow:compile_completed', compileId: 'c2', target: 'skill-chain', durationMs: 20 })
            }
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const app = buildApp()
    const res = await postCompile(
      app,
      { flow: { type: 'action', tool: 't' } },
      { Accept: 'text/event-stream' },
    )

    const raw = await readSSERaw(res, 3000, 'flow:compile_result')
    const pairs = parseSSEPairs(raw)
    const types = pairs.map((p) => p.event)

    expect(types).toContain('flow:compile_started')
    expect(types).toContain('flow:compile_completed')
    expect(types).toContain('flow:compile_result')

    const resultEvent = pairs.find((p) => p.event === 'flow:compile_result')
    expect(resultEvent).toBeDefined()
    expect(JSON.parse(resultEvent!.data)).toMatchObject({
      type: 'flow:compile_result',
      compileId: 'cid-abc-123',
      reasons: [{ code: 'SEQUENTIAL_ONLY' }],
    })
  })

  it('SSE stream emits flow:compile_failed when compiler emits failure event', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              capturedBus.emit({ type: 'flow:compile_started', compileId: 'c3', inputKind: 'object' })
              capturedBus.emit({ type: 'flow:compile_failed', compileId: 'c3', stage: 2, errorCount: 1, durationMs: 5 })
            }
            return { errors: [{ stage: 2, message: 'shape error' }], compileId: 'c3' }
          }),
        }
      },
    )

    const app = buildApp()
    const res = await postCompile(
      app,
      { flow: { type: 'bad' } },
      { Accept: 'text/event-stream' },
    )

    const raw = await readSSERaw(res, 3000)
    const pairs = parseSSEPairs(raw)
    const types = pairs.map((p) => p.event)

    expect(types).toContain('flow:compile_failed')
  })

  it('SSE stream emits error event when compiler throws', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            // Emit a compile_failed event so the SSE drain loop can terminate
            if (capturedBus) {
              capturedBus.emit({
                type: 'flow:compile_failed',
                compileId: 'c-err',
                stage: 1,
                errorCount: 1,
                durationMs: 1,
              })
            }
            throw new Error('fatal compiler panic')
          }),
        }
      },
    )

    const app = buildApp()
    const res = await postCompile(
      app,
      { flow: { type: 'action', tool: 't' } },
      { Accept: 'text/event-stream' },
    )

    // Should still return 200 SSE response header — errors are in the stream
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const raw = await readSSERaw(res, 1000, 'flow:compile_failed')
    const pairs = parseSSEPairs(raw)

    // The compile_failed event from the bus is present
    const failedEvent = pairs.find((p) => p.event === 'flow:compile_failed')
    expect(failedEvent).toBeDefined()
  })

  it('SSE only emits flow:compile_* events, not unrelated bus events', async () => {
    let capturedBus: { emit: (e: unknown) => void } | null = null

    mockCreateFlowCompiler.mockImplementationOnce(
      (cfg: { eventBus?: typeof capturedBus }) => {
        capturedBus = cfg.eventBus ?? null
        return {
          compile: vi.fn().mockImplementationOnce(async () => {
            if (capturedBus) {
              // Emit an unrelated event (should be filtered)
              capturedBus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
              capturedBus.emit({ type: 'flow:compile_started', compileId: 'c4', inputKind: 'object' })
              capturedBus.emit({ type: 'flow:compile_completed', compileId: 'c4', target: 'skill-chain', durationMs: 1 })
            }
            return SUCCESS_RESULT
          }),
        }
      },
    )

    const app = buildApp()
    const res = await postCompile(
      app,
      { flow: { type: 'action', tool: 't' } },
      { Accept: 'text/event-stream' },
    )

    const raw = await readSSERaw(res)
    const pairs = parseSSEPairs(raw)

    // No 'agent:started' event should be in the stream
    const nonCompileEvents = pairs.filter((p) => !p.event.startsWith('flow:'))
    expect(nonCompileEvents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Subprocess SSE branch (?subprocess=true)
// ---------------------------------------------------------------------------

describe('POST /api/workflows/compile — subprocess SSE branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHandleSubprocessCompile.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates to handleSubprocessCompile when ?subprocess=true + Accept: text/event-stream', async () => {
    const app = buildApp()

    const res = await app.request('/api/workflows/compile?subprocess=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ flow: { type: 'action', tool: 't' } }),
    })

    expect(mockHandleSubprocessCompile).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
  })

  it('does NOT delegate to subprocess when ?subprocess=true but Accept is application/json', async () => {
    mockCompile.mockResolvedValueOnce(SUCCESS_RESULT)
    const app = buildApp()

    const res = await app.request('/api/workflows/compile?subprocess=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: { type: 'action', tool: 't' } }),
    })

    // Falls through to JSON branch — subprocess mock should NOT be called
    expect(mockHandleSubprocessCompile).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  it('passes flow object to handleSubprocessCompile', async () => {
    const flowInput = { type: 'action', tool: 'specialTool' }
    const app = buildApp()

    await app.request('/api/workflows/compile?subprocess=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ flow: flowInput }),
    })

    expect(mockHandleSubprocessCompile).toHaveBeenCalledWith(
      expect.anything(), // Hono context
      flowInput,
      expect.objectContaining({ eventGateway: undefined }),
    )
  })

  it('400 — validation still runs before subprocess branch (missing flow)', async () => {
    const app = buildApp()

    const res = await app.request('/api/workflows/compile?subprocess=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ target: 'skill-chain' }),
    })

    expect(res.status).toBe(400)
    expect(mockHandleSubprocessCompile).not.toHaveBeenCalled()
  })

  it('400 — validation still runs before subprocess branch (invalid target)', async () => {
    const app = buildApp()

    const res = await app.request('/api/workflows/compile?subprocess=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ flow: { type: 'action' }, target: 'bad-target' }),
    })

    expect(res.status).toBe(400)
    expect(mockHandleSubprocessCompile).not.toHaveBeenCalled()
  })
})
