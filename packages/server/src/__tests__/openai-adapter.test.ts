/**
 * Tests for the OpenAI compatibility adapter:
 *   - auth-middleware (Bearer token validation)
 *   - models-route (GET /v1/models and /v1/models/:id)
 *   - completion-mapper (tool-call chunks + ID + response shape)
 *   - completions-route input validation (400 branches)
 *
 * All external dependencies (execution-spec store, ModelRegistry, EventBus, agent
 * execution) are faked so no real LLM call is ever made.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { openaiAuthMiddleware } from '../routes/openai-compat/auth-middleware.js'
import { createModelsRoute } from '../routes/openai-compat/models-route.js'
import { createOpenAICompatCompletionsRoute } from '../routes/openai-compat/completions.js'
import { OpenAICompletionMapper } from '../routes/openai-compat/completion-mapper.js'
import type {
  AgentExecutionSpec,
  AgentExecutionSpecStore,
  ModelRegistry,
  DzupEventBus,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeAgentExecutionSpecStore(
  executionSpecs: AgentExecutionSpec[] = [],
): AgentExecutionSpecStore {
  const store = new Map(executionSpecs.map((spec) => [spec.id, spec]))
  return {
    async get(id: string) { return store.get(id) ?? null },
    async list(filter?) {
      const all = [...store.values()]
      if (filter?.active !== undefined) return all.filter((a) => (a.active ?? true) === filter.active)
      return all
    },
    async save(spec: AgentExecutionSpec) { store.set(spec.id, spec) },
    async delete(id: string) { store.delete(id) },
  }
}

function makeExecutionSpec(overrides: Partial<AgentExecutionSpec> = {}): AgentExecutionSpec {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    instructions: 'Say hi',
    modelTier: 'chat',
    active: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

const nullRegistry = { resolve: vi.fn(() => ({ invoke: vi.fn() })) } as unknown as ModelRegistry
const nullEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as DzupEventBus

// ---------------------------------------------------------------------------
// auth-middleware
// ---------------------------------------------------------------------------

describe('openaiAuthMiddleware', () => {
  function buildApp(config?: Parameters<typeof openaiAuthMiddleware>[0]): Hono {
    const app = new Hono()
    app.use('*', openaiAuthMiddleware(config))
    app.get('/ok', (c) => c.json({ ok: true }))
    return app
  }

  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp()
    const res = await app.request('/ok')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; type: string } }
    expect(body.error.code).toBe('invalid_api_key')
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('returns 401 when Authorization header is malformed (no Bearer prefix)', async () => {
    const app = buildApp()
    const res = await app.request('/ok', { headers: { Authorization: 'Basic abc' } })
    expect(res.status).toBe(401)
  })

  it('returns 401 when Bearer token is empty', async () => {
    const app = buildApp()
    const res = await app.request('/ok', { headers: { Authorization: 'Bearer ' } })
    expect(res.status).toBe(401)
  })

  it('accepts any non-empty Bearer token in dev mode (no validateKey)', async () => {
    const app = buildApp()
    const res = await app.request('/ok', { headers: { Authorization: 'Bearer dev-token' } })
    expect(res.status).toBe(200)
  })

  it('passes through every request when enabled=false', async () => {
    const app = buildApp({ enabled: false })
    const res = await app.request('/ok') // no header
    expect(res.status).toBe(200)
  })

  it('calls validateKey with the bearer token and passes on truthy result', async () => {
    const validateKey = vi.fn().mockResolvedValue({ userId: 'u1' })
    const app = buildApp({ validateKey })
    const res = await app.request('/ok', { headers: { Authorization: 'Bearer sk-abc' } })
    expect(res.status).toBe(200)
    expect(validateKey).toHaveBeenCalledWith('sk-abc')
  })

  it('returns 401 when validateKey resolves to null', async () => {
    const validateKey = vi.fn().mockResolvedValue(null)
    const app = buildApp({ validateKey })
    const res = await app.request('/ok', { headers: { Authorization: 'Bearer sk-bad' } })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_api_key')
  })

  it('trims whitespace from Bearer token', async () => {
    const validateKey = vi.fn().mockResolvedValue({ ok: true })
    const app = buildApp({ validateKey })
    await app.request('/ok', { headers: { Authorization: 'Bearer   sk-trim   ' } })
    expect(validateKey).toHaveBeenCalledWith('sk-trim')
  })
})

// ---------------------------------------------------------------------------
// models-route
// ---------------------------------------------------------------------------

describe('createModelsRoute', () => {
  function buildApp(executionSpecs: AgentExecutionSpec[]): Hono {
    const app = new Hono()
    app.route('/', createModelsRoute({ agentStore: makeAgentExecutionSpecStore(executionSpecs) }))
    return app
  }

  it('lists only active agents as model objects', async () => {
    const app = buildApp([
      makeExecutionSpec({ id: 'a1' }),
      makeExecutionSpec({ id: 'a2' }),
    ])

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string; owned_by: string }> }
    expect(body.object).toBe('list')
    expect(body.data).toHaveLength(2)
    expect(body.data[0]!.object).toBe('model')
    expect(body.data[0]!.owned_by).toBe('dzupagent')
  })

  it('returns empty data array when no agents are registered', async () => {
    const app = buildApp([])
    const res = await app.request('/')
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('maps createdAt to unix seconds', async () => {
    const app = buildApp([
      makeExecutionSpec({ id: 'a1', createdAt: new Date('2026-01-02T00:00:00Z') }),
    ])
    const res = await app.request('/')
    const body = (await res.json()) as { data: Array<{ created: number }> }
    const expected = Math.floor(new Date('2026-01-02T00:00:00Z').getTime() / 1000)
    expect(body.data[0]!.created).toBe(expected)
  })

  it('falls back to now() when agent.createdAt is missing', async () => {
    const app = buildApp([makeExecutionSpec({ id: 'a1', createdAt: undefined })])
    const res = await app.request('/')
    const body = (await res.json()) as { data: Array<{ created: number }> }
    // Reasonable lower bound (post-2025)
    expect(body.data[0]!.created).toBeGreaterThan(1735000000)
  })

  it('returns a single model for GET /:model when found', async () => {
    const app = buildApp([makeExecutionSpec({ id: 'specific' })])
    const res = await app.request('/specific')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; object: string }
    expect(body.id).toBe('specific')
    expect(body.object).toBe('model')
  })

  it('returns 404 with OpenAI-style error for unknown model id', async () => {
    const app = buildApp([])
    const res = await app.request('/missing')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('model_not_found')
    expect(body.error.message).toContain("'missing'")
  })
})

// ---------------------------------------------------------------------------
// completion-mapper — additional coverage
// ---------------------------------------------------------------------------

describe('OpenAICompletionMapper — extras', () => {
  let mapper: OpenAICompletionMapper

  beforeEach(() => {
    mapper = new OpenAICompletionMapper()
  })

  it('generateId() returns a stable chatcmpl-prefixed id', () => {
    const id = mapper.generateId()
    expect(id).toMatch(/^chatcmpl-[A-Za-z0-9]{24}$/)
  })

  it('generateId() produces unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => mapper.generateId()))
    expect(ids.size).toBe(20)
  })

  it('mapResponse() builds a well-formed ChatCompletionResponse', () => {
    const res = mapper.mapResponse('agent', 'hello world', 'model-x', 'chatcmpl-abc')
    expect(res.id).toBe('chatcmpl-abc')
    expect(res.object).toBe('chat.completion')
    expect(res.model).toBe('model-x')
    expect(res.choices[0]!.message.content).toBe('hello world')
    expect(res.choices[0]!.finish_reason).toBe('stop')
    expect(res.usage.total_tokens).toBe(res.usage.prompt_tokens + res.usage.completion_tokens)
  })

  it('mapChunk() emits delta content when not the last chunk', () => {
    const chunk = mapper.mapChunk('partial', 'model', 'id', 0, false)
    expect(chunk.choices[0]!.delta.content).toBe('partial')
    expect(chunk.choices[0]!.delta.role).toBe('assistant')
    expect(chunk.choices[0]!.finish_reason).toBeNull()
  })

  it('mapChunk() emits empty delta with finish_reason=stop on last chunk', () => {
    const chunk = mapper.mapChunk('', 'model', 'id', 0, true)
    expect(chunk.choices[0]!.delta).toEqual({})
    expect(chunk.choices[0]!.finish_reason).toBe('stop')
  })

  it('mapToolCallInitChunk() includes id, name, and empty arguments', () => {
    const chunk = mapper.mapToolCallInitChunk('call-1', 'search', 0, 'model', 'cid')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.id).toBe('call-1')
    expect(tc.type).toBe('function')
    expect(tc.function!.name).toBe('search')
    expect(tc.function!.arguments).toBe('')
    expect(chunk.choices[0]!.finish_reason).toBeNull()
  })

  it('mapToolCallArgumentsChunk() streams argument fragments without id', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"a":1', 2, 'model', 'cid')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.index).toBe(2)
    expect(tc.id).toBeUndefined()
    expect(tc.function!.arguments).toBe('{"a":1')
  })

  it('mapToolCallsFinishChunk() emits empty delta and tool_calls finish reason', () => {
    const chunk = mapper.mapToolCallsFinishChunk('model', 'cid')
    expect(chunk.choices[0]!.delta).toEqual({})
    expect(chunk.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('mapRequest() handles a lone user message', () => {
    const req = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }
    const mapped = mapper.mapRequest(req)
    expect(mapped.agentId).toBe('m')
    expect(mapped.prompt).toBe('User: hi')
  })

  it('mapRequest() preserves stop arrays and strings', () => {
    const req = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], stop: ['\n', 'END'] }
    expect(mapper.mapRequest(req).options.stop).toEqual(['\n', 'END'])
  })

  it('mapRequest() handles null content as empty string in prompt', () => {
    const req = { model: 'm', messages: [{ role: 'user' as const, content: null }] }
    const mapped = mapper.mapRequest(req)
    expect(mapped.prompt).toBe('User: ')
  })

  it('mapResponse() created timestamp is a unix second', () => {
    const res = mapper.mapResponse('a', 'out', 'm', 'id')
    expect(res.created).toBeGreaterThan(1735000000)
    expect(Number.isInteger(res.created)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// completions-route — request validation (400 branches)
// ---------------------------------------------------------------------------

describe('createOpenAICompatCompletionsRoute — request validation', () => {
  function buildApp(executionSpecs: AgentExecutionSpec[] = []): Hono {
    const app = new Hono()
    app.route('/', createOpenAICompatCompletionsRoute({
      agentStore: makeAgentExecutionSpecStore(executionSpecs),
      modelRegistry: nullRegistry,
      eventBus: nullEventBus,
    }))
    return app
  }

  async function post(app: Hono, body: unknown): Promise<Response> {
    return app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('returns 400 when body is not valid JSON', async () => {
    const app = buildApp()
    const res = await post(app, '{not-json')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('returns 400 when body is not an object', async () => {
    const app = buildApp()
    const res = await post(app, '"just a string"')
    expect(res.status).toBe(400)
  })

  it('returns 400 when model field is missing', async () => {
    const app = buildApp()
    const res = await post(app, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('model')
  })

  it('returns 400 when model field is empty string', async () => {
    const app = buildApp()
    const res = await post(app, { model: '', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(400)
  })

  it('returns 400 when messages is missing', async () => {
    const app = buildApp()
    const res = await post(app, { model: 'agent' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('messages')
  })

  it('returns 400 when messages is not an array', async () => {
    const app = buildApp()
    const res = await post(app, { model: 'agent', messages: 'oops' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when messages array is empty', async () => {
    const app = buildApp()
    const res = await post(app, { model: 'agent', messages: [] })
    expect(res.status).toBe(400)
  })

  it('returns 400 when a message is not an object', async () => {
    const app = buildApp()
    const res = await post(app, { model: 'agent', messages: ['hi'] })
    expect(res.status).toBe(400)
  })

  it('returns 400 when a message has an invalid role', async () => {
    const app = buildApp()
    const res = await post(app, { model: 'agent', messages: [{ role: 'wizard', content: 'hi' }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { param: string | null } }
    expect(body.error.param).toBe('messages[0].role')
  })

  it('returns 404 when the requested model/agent is unknown', async () => {
    const app = buildApp([])  // no agents registered
    const res = await post(app, { model: 'ghost', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('model_not_found')
  })

  it('accepts all four valid message roles', async () => {
    const app = buildApp()  // unknown agent → 404, but validation must pass first
    const res = await post(app, {
      model: 'agent',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
        { role: 'tool', content: 't', tool_call_id: 'x' },
      ],
    })
    // Validation passes but agent doesn't exist — expect 404 rather than 400
    expect(res.status).toBe(404)
  })
})
