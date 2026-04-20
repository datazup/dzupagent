import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { AgentDefinition } from '@dzupagent/core'
import { createForgeApp, type ForgeServerConfig } from '../../../app.js'
import { DzupAgent } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Mock DzupAgent so we never need a real LLM
// ---------------------------------------------------------------------------

const mockGenerate = vi.fn()
const mockStream = vi.fn()

vi.mock('@dzupagent/agent', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    DzupAgent: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ECHO_AGENT: AgentDefinition = {
  id: 'echo',
  name: 'Echo Agent',
  description: 'Echoes back input',
  instructions: 'Echo whatever the user says.',
  modelTier: 'chat',
  active: true,
}

function createTestConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    openai: { auth: { enabled: false } },
    ...overrides,
  }
}

async function seedAgent(agentStore: ForgeServerConfig['agentStore']): Promise<void> {
  await agentStore.save(ECHO_AGENT)
}

function makeCompletionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'echo',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAI-compatible routes', () => {
  let app: Hono
  let agentStore: InMemoryAgentStore

  beforeEach(async () => {
    mockGenerate.mockReset()
    mockStream.mockReset()

    // Re-apply the DzupAgent constructor mock (vi.clearAllMocks would wipe it)
    vi.mocked(DzupAgent).mockImplementation((() => ({
      generate: mockGenerate,
      stream: mockStream,
    })) as unknown as () => InstanceType<typeof DzupAgent>)

    agentStore = new InMemoryAgentStore()
    await seedAgent(agentStore)

    app = createForgeApp(createTestConfig({ agentStore }))

    // Default mock: successful generate
    mockGenerate.mockResolvedValue({
      content: 'Echo: hello',
      messages: [],
      usage: { totalInputTokens: 10, totalOutputTokens: 5, llmCalls: 1 },
      hitIterationLimit: false,
      stopReason: 'end_turn',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Non-streaming completions
  // -------------------------------------------------------------------------

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it('should return 200 with a valid ChatCompletionResponse shape', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody()),
      })

      expect(res.status).toBe(200)

      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
      expect(typeof body['id']).toBe('string')
      expect((body['id'] as string).startsWith('chatcmpl-')).toBe(true)
      expect(typeof body['created']).toBe('number')
      expect(body['model']).toBe('echo')

      const choices = body['choices'] as Array<Record<string, unknown>>
      expect(choices).toHaveLength(1)
      expect((choices[0]!['message'] as Record<string, unknown>)['role']).toBe('assistant')
      expect((choices[0]!['message'] as Record<string, unknown>)['content']).toBe('Echo: hello')

      const usage = body['usage'] as Record<string, unknown>
      expect(usage['prompt_tokens']).toBe(10)
      expect(usage['completion_tokens']).toBe(5)
      expect(usage['total_tokens']).toBe(15)
    })

    it('should accept and process temperature parameter', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ temperature: 0.7 })),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })

    it('should accept and process max_tokens parameter', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ max_tokens: 100 })),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })

    it('should accept and process top_p parameter', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ top_p: 0.9 })),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })

    it('should accept and process presence_penalty parameter', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ presence_penalty: 0.5 })),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })

    it('should accept and process frequency_penalty parameter', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ frequency_penalty: 0.3 })),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })

    it('should accept and process seed parameter', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ seed: 12345 })),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })
  })

  // -------------------------------------------------------------------------
  // Streaming completions
  // -------------------------------------------------------------------------

  describe('POST /v1/chat/completions (streaming)', () => {
    it('should return an SSE stream with valid chunks and [DONE] terminator', async () => {
      // Mock stream that yields two text events and a done event
      mockStream.mockImplementation(async function* () {
        yield { type: 'text', data: { content: 'Hello' } }
        yield { type: 'text', data: { content: ' world' } }
        yield { type: 'done', data: {} }
      })

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ stream: true })),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const text = await res.text()
      const lines = text.split('\n').filter((l) => l.startsWith('data:'))

      // At least: 2 text chunks + 1 final chunk with finish_reason=stop + [DONE]
      // (The route emits one chunk per text event, one final chunk, and [DONE])
      expect(lines.length).toBeGreaterThanOrEqual(3)

      // Check that non-DONE lines are valid JSON
      const jsonLines = lines.filter((l) => l.trim() !== 'data: [DONE]' && l.trim() !== 'data:[DONE]')
      for (const line of jsonLines) {
        const jsonStr = line.replace(/^data:\s*/, '')
        const chunk = JSON.parse(jsonStr) as Record<string, unknown>
        expect(chunk['object']).toBe('chat.completion.chunk')
        expect(typeof chunk['id']).toBe('string')
      }

      // Check the final line is [DONE]
      const lastDataLine = lines[lines.length - 1]!
      expect(lastDataLine.replace(/^data:\s*/, '').trim()).toBe('[DONE]')

      // Verify the second-to-last JSON chunk has finish_reason=stop
      const secondToLastJsonLine = jsonLines[jsonLines.length - 1]!
      const finalChunk = JSON.parse(secondToLastJsonLine.replace(/^data:\s*/, '')) as Record<string, unknown>
      const finalChoices = finalChunk['choices'] as Array<Record<string, unknown>>
      expect(finalChoices[0]!['finish_reason']).toBe('stop')
    })
  })

  // -------------------------------------------------------------------------
  // Models listing
  // -------------------------------------------------------------------------

  describe('GET /v1/models', () => {
    it('should return 200 with a list of models', async () => {
      const res = await app.request('/v1/models', {
        method: 'GET',
      })

      expect(res.status).toBe(200)

      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('list')

      const data = body['data'] as Array<Record<string, unknown>>
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThanOrEqual(1)
      expect(data.some((m) => m['id'] === 'echo')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Model detail retrieval
  // -------------------------------------------------------------------------

  describe('GET /v1/models/:id', () => {
    it('should return 200 with model details for a valid model id', async () => {
      const res = await app.request('/v1/models/echo', {
        method: 'GET',
      })

      expect(res.status).toBe(200)

      const body = await res.json() as Record<string, unknown>
      expect(body['id']).toBe('echo')
      expect(body['object']).toBe('model')
      expect(typeof body['created']).toBe('number')
      expect(body['owned_by']).toBe('dzupagent')
    })

    it('should return 404 in OpenAI error format for non-existent model id', async () => {
      const res = await app.request('/v1/models/non-existent-model-xyz', {
        method: 'GET',
      })

      expect(res.status).toBe(404)

      const body = await res.json() as Record<string, unknown>
      const error = body['error'] as Record<string, unknown>
      expect(error).toBeDefined()
      expect(error['code']).toBe('model_not_found')
      expect(typeof error['message']).toBe('string')
      expect(error['message']).toContain('non-existent-model-xyz')
      expect(error['type']).toBe('invalid_request_error')
    })
  })

  // -------------------------------------------------------------------------
  // Error: model not found
  // -------------------------------------------------------------------------

  describe('Error handling', () => {
    it('should return 404 in OpenAI error format for unknown model', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody({ model: 'nonexistent-agent' })),
      })

      expect(res.status).toBe(404)

      const body = await res.json() as Record<string, unknown>
      const error = body['error'] as Record<string, unknown>
      expect(error).toBeDefined()
      expect(typeof error['message']).toBe('string')
      expect(typeof error['type']).toBe('string')
      expect(error['code']).toBe('model_not_found')
      expect(error).toHaveProperty('param')
    })

    it('should return 400 in OpenAI error format for malformed request body', async () => {
      // Missing required 'model' and 'messages'
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)

      const body = await res.json() as Record<string, unknown>
      const error = body['error'] as Record<string, unknown>
      expect(error).toBeDefined()
      expect(typeof error['message']).toBe('string')
      expect(typeof error['type']).toBe('string')
      expect(error).toHaveProperty('code')
      expect(error).toHaveProperty('param')
    })

    it('should return 400 for missing messages array', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'echo' }),
      })

      expect(res.status).toBe(400)

      const body = await res.json() as Record<string, unknown>
      expect(body['error']).toBeDefined()
    })

    it('should return 400 for invalid message role', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'echo',
          messages: [{ role: 'invalid-role', content: 'hi' }],
        }),
      })

      expect(res.status).toBe(400)

      const body = await res.json() as Record<string, unknown>
      const error = body['error'] as Record<string, unknown>
      expect(error['type']).toBe('invalid_request_error')
    })

    it('should return 400 for non-JSON body', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'this is not json',
      })

      expect(res.status).toBe(400)

      const body = await res.json() as Record<string, unknown>
      expect(body['error']).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Auth middleware
  // -------------------------------------------------------------------------

  describe('Auth middleware', () => {
    it('should return 401 when auth is enabled and no Authorization header is provided', async () => {
      const authedApp = createForgeApp(
        createTestConfig({
          agentStore,
          openai: { auth: { enabled: true } },
        }),
      )

      const res = await authedApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCompletionBody()),
      })

      expect(res.status).toBe(401)

      const body = await res.json() as Record<string, unknown>
      const error = body['error'] as Record<string, unknown>
      expect(error).toBeDefined()
      expect(typeof error['message']).toBe('string')
      expect(error['code']).toBe('invalid_api_key')
      expect(error['type']).toBe('invalid_request_error')
      expect(error).toHaveProperty('param')
    })

    it('should pass through when auth is enabled and a valid Bearer token is provided', async () => {
      const authedApp = createForgeApp(
        createTestConfig({
          agentStore,
          openai: { auth: { enabled: true } },
        }),
      )

      const res = await authedApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key-123',
        },
        body: JSON.stringify(makeCompletionBody()),
      })

      // Should not be 401 - either 200 (success) or another non-auth error
      expect(res.status).not.toBe(401)
    })
  })
})
