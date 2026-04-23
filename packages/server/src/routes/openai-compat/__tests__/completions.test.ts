/**
 * Integration tests for the enhanced OpenAI-compatible completions route.
 *
 * Verifies that all three gap fixes work end-to-end through the route:
 *
 * GAP-1: System messages are extracted and composed with agent instructions,
 *        not passed as conversation turns in the flat prompt.
 *
 * GAP-2: Streaming done events with hitIterationLimit=true produce chunks
 *        with finish_reason='length' rather than 'stop'.
 *
 * GAP-3: Non-streaming responses include tool_calls in the choice message
 *        when the agent's result messages contain tool invocations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { AgentDefinition } from '@dzupagent/core'
import { DzupAgent } from '@dzupagent/agent'
import { Hono as HonoApp } from 'hono'
import { createOpenAICompatCompletionsRoute } from '../completions.js'
import type { OpenAICompatCompletionsConfig } from '../completions.js'

// ---------------------------------------------------------------------------
// Mock DzupAgent
// ---------------------------------------------------------------------------

const mockGenerate = vi.fn()
const mockStream = vi.fn()
let capturedConfig: Record<string, unknown> | undefined

vi.mock('@dzupagent/agent', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    DzupAgent: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_AGENT: AgentDefinition = {
  id: 'helper',
  name: 'Helper Agent',
  description: 'A helpful agent',
  instructions: 'Default instructions.',
  modelTier: 'chat',
  active: true,
}

function buildConfig(agentStore: InMemoryAgentStore): OpenAICompatCompletionsConfig {
  return {
    agentStore,
    modelRegistry: new ModelRegistry(),
    eventBus: createEventBus(),
  }
}

function buildApp(config: OpenAICompatCompletionsConfig): Hono {
  const app = new HonoApp()
  app.route('/', createOpenAICompatCompletionsRoute(config))
  return app
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'helper',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

function defaultGenerateResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: 'Hi there!',
    messages: [],
    usage: { totalInputTokens: 10, totalOutputTokens: 5, llmCalls: 1 },
    hitIterationLimit: false,
    stopReason: 'end_turn',
    toolStats: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('OpenAI-compat completions route', () => {
  let app: Hono
  let agentStore: InMemoryAgentStore

  beforeEach(async () => {
    mockGenerate.mockReset()
    mockStream.mockReset()
    capturedConfig = undefined

    vi.mocked(DzupAgent).mockImplementation(((cfg: Record<string, unknown>) => {
      capturedConfig = cfg
      return { generate: mockGenerate, stream: mockStream }
    }) as unknown as () => InstanceType<typeof DzupAgent>)

    agentStore = new InMemoryAgentStore()
    await agentStore.save(BASE_AGENT)

    mockGenerate.mockResolvedValue(defaultGenerateResult())
    app = buildApp(buildConfig(agentStore))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Basic non-streaming
  // -------------------------------------------------------------------------

  describe('POST / (non-streaming) — basic', () => {
    it('returns 200 with ChatCompletionResponse shape', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
      expect(typeof body['id']).toBe('string')
      expect((body['id'] as string).startsWith('chatcmpl-')).toBe(true)
    })

    it('returns 404 when agent not found', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ model: 'nonexistent' })),
      })

      expect(res.status).toBe(404)
      const body = await res.json() as Record<string, unknown>
      expect((body['error'] as Record<string, unknown>)['code']).toBe('model_not_found')
    })

    it('returns 400 for missing model', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for missing messages', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'helper' }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for non-JSON body', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid role', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'helper',
          messages: [{ role: 'unknown-role', content: 'hi' }],
        }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 500 when generate() throws', async () => {
      mockGenerate.mockRejectedValue(new Error('LLM error'))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      expect(res.status).toBe(500)
      const body = await res.json() as Record<string, unknown>
      expect((body['error'] as Record<string, unknown>)['type']).toBe('server_error')
    })
  })

  // -------------------------------------------------------------------------
  // GAP-1: System message handling
  // -------------------------------------------------------------------------

  describe('GAP-1: System message extraction and instruction composition', () => {
    it('composes system message content with stored agent instructions', async () => {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({
          messages: [
            { role: 'system', content: 'Override instructions.' },
            { role: 'user', content: 'hello' },
          ],
        })),
      })

      expect(capturedConfig).toBeDefined()
      const instructions = capturedConfig!['instructions'] as string
      // Should include both the base agent instructions and the system override
      expect(instructions).toContain('Default instructions.')
      expect(instructions).toContain('Override instructions.')
    })

    it('uses only agent instructions when no system message is present', async () => {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({
          messages: [{ role: 'user', content: 'hello' }],
        })),
      })

      expect(capturedConfig!['instructions']).toBe('Default instructions.')
    })

    it('does NOT pass system message content in the generate() input prompt', async () => {
      let capturedMessages: unknown = undefined
      mockGenerate.mockImplementation((msgs: unknown) => {
        capturedMessages = msgs
        return Promise.resolve(defaultGenerateResult())
      })

      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({
          messages: [
            { role: 'system', content: 'System instruction here.' },
            { role: 'user', content: 'User question.' },
          ],
        })),
      })

      const msgs = capturedMessages as Array<{ text?: string; content?: string }>
      expect(Array.isArray(msgs)).toBe(true)
      // The HumanMessage passed to generate() should NOT contain the system content
      const msgTexts = msgs.map((m) => {
        const raw = m as unknown as Record<string, unknown>
        return typeof raw['content'] === 'string' ? raw['content'] : ''
      }).join(' ')
      expect(msgTexts).not.toContain('System instruction here.')
      expect(msgTexts).toContain('User question.')
    })

    it('handles multiple system messages by concatenating them', async () => {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({
          messages: [
            { role: 'system', content: 'Rule A' },
            { role: 'system', content: 'Rule B' },
            { role: 'user', content: 'hello' },
          ],
        })),
      })

      const instructions = capturedConfig!['instructions'] as string
      expect(instructions).toContain('Rule A')
      expect(instructions).toContain('Rule B')
    })
  })

  // -------------------------------------------------------------------------
  // GAP-2: Streaming finish_reason for iteration limits
  // -------------------------------------------------------------------------

  describe('GAP-2: Streaming finish_reason=length for iteration limits', () => {
    async function parseSSEChunks(body: string): Promise<Array<Record<string, unknown>>> {
      const lines = body.split('\n').filter((l) => l.startsWith('data:'))
      const chunks: Array<Record<string, unknown>> = []
      for (const line of lines) {
        const jsonStr = line.replace(/^data:\s*/, '').trim()
        if (jsonStr === '[DONE]') continue
        try {
          chunks.push(JSON.parse(jsonStr) as Record<string, unknown>)
        } catch {
          // skip invalid JSON
        }
      }
      return chunks
    }

    it('emits finish_reason=stop for a normal done event', async () => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'text', data: { content: 'Hello' } }
        yield { type: 'done', data: { stopReason: 'end_turn', hitIterationLimit: false } }
      })

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ stream: true })),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      const chunks = await parseSSEChunks(text)

      const finalChunk = chunks[chunks.length - 1]!
      const choice = (finalChunk['choices'] as Array<Record<string, unknown>>)[0]!
      expect(choice['finish_reason']).toBe('stop')
    })

    it('emits finish_reason=length when done event has hitIterationLimit=true', async () => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'text', data: { content: 'Partial response...' } }
        yield { type: 'done', data: { hitIterationLimit: true, stopReason: 'iteration_limit' } }
      })

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ stream: true })),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      const chunks = await parseSSEChunks(text)

      const finalChunk = chunks[chunks.length - 1]!
      const choice = (finalChunk['choices'] as Array<Record<string, unknown>>)[0]!
      expect(choice['finish_reason']).toBe('length')
    })

    it('emits finish_reason=length when stopReason=budget_exceeded', async () => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'done', data: { hitIterationLimit: true, stopReason: 'budget_exceeded' } }
      })

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ stream: true })),
      })

      const text = await res.text()
      const chunks = await parseSSEChunks(text)

      const finalChunk = chunks[chunks.length - 1]!
      const choice = (finalChunk['choices'] as Array<Record<string, unknown>>)[0]!
      expect(choice['finish_reason']).toBe('length')
    })

    it('always terminates the SSE stream with [DONE]', async () => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'done', data: {} }
      })

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ stream: true })),
      })

      const text = await res.text()
      const dataLines = text.split('\n').filter((l) => l.startsWith('data:'))
      const lastLine = dataLines[dataLines.length - 1]!.replace(/^data:\s*/, '').trim()
      expect(lastLine).toBe('[DONE]')
    })

    it('content-type is text/event-stream', async () => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'done', data: {} }
      })

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ stream: true })),
      })

      expect(res.headers.get('content-type')).toContain('text/event-stream')
    })

    it('emits error chunk when stream throws', async () => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'text', data: { content: 'starting...' } }
        throw new Error('stream failure')
         
        yield { type: 'done', data: {} }
      })

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ stream: true })),
      })

      expect(res.status).toBe(200) // SSE streams start with 200
      const text = await res.text()
      // Should contain an error chunk
      expect(text).toContain('server_error')
    })

    it('handles error events from stream without crashing', async () => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'error', data: { message: 'model unavailable' } }
      })

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ stream: true })),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('model unavailable')
    })
  })

  // -------------------------------------------------------------------------
  // GAP-3: Non-streaming tool_calls in response
  // -------------------------------------------------------------------------

  describe('GAP-3: Non-streaming tool_calls in response', () => {
    function makeAIMessageWithTools(
      toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    ) {
      return {
        _getType: () => 'ai',
        content: '',
        tool_calls: toolCalls,
      }
    }

    it('omits tool_calls from message when agent invoked no tools', async () => {
      mockGenerate.mockResolvedValue(defaultGenerateResult({
        content: 'plain text',
        messages: [],
      }))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      const body = await res.json() as Record<string, unknown>
      const message = ((body['choices'] as Array<Record<string, unknown>>)[0]!['message'] as Record<string, unknown>)
      expect(message['tool_calls']).toBeUndefined()
    })

    it('includes tool_calls in message when agent invoked tools', async () => {
      const messages = [
        makeAIMessageWithTools([
          { id: 'call_abc', name: 'search', args: { query: 'test' } },
        ]),
      ]
      mockGenerate.mockResolvedValue(defaultGenerateResult({
        content: '',
        messages,
      }))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      const body = await res.json() as Record<string, unknown>
      const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!
      const message = choice['message'] as Record<string, unknown>
      const toolCalls = message['tool_calls'] as Array<Record<string, unknown>>

      expect(Array.isArray(toolCalls)).toBe(true)
      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0]!['id']).toBe('call_abc')
      expect((toolCalls[0]!['function'] as Record<string, unknown>)['name']).toBe('search')
    })

    it('sets finish_reason=tool_calls when tools were invoked', async () => {
      const messages = [
        makeAIMessageWithTools([
          { id: 'c1', name: 'fn', args: {} },
        ]),
      ]
      mockGenerate.mockResolvedValue(defaultGenerateResult({ messages }))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      const body = await res.json() as Record<string, unknown>
      const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!
      expect(choice['finish_reason']).toBe('tool_calls')
    })

    it('sets finish_reason=length when hitIterationLimit with no tools', async () => {
      mockGenerate.mockResolvedValue(defaultGenerateResult({
        hitIterationLimit: true,
        messages: [],
      }))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      const body = await res.json() as Record<string, unknown>
      const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!
      expect(choice['finish_reason']).toBe('length')
    })

    it('includes correct tool argument JSON in tool_calls', async () => {
      const args = { query: 'hello world', limit: 5 }
      const messages = [
        makeAIMessageWithTools([
          { id: 'c1', name: 'search', args },
        ]),
      ]
      mockGenerate.mockResolvedValue(defaultGenerateResult({ messages }))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      const body = await res.json() as Record<string, unknown>
      const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!
      const message = choice['message'] as Record<string, unknown>
      const toolCalls = message['tool_calls'] as Array<Record<string, unknown>>
      const fn = toolCalls[0]!['function'] as Record<string, unknown>
      expect(fn['arguments']).toBe(JSON.stringify(args))
    })

    it('includes multiple tool_calls when agent invoked several tools', async () => {
      const messages = [
        makeAIMessageWithTools([
          { id: 'c1', name: 'search', args: { q: 'a' } },
          { id: 'c2', name: 'fetch', args: { url: 'b' } },
        ]),
      ]
      mockGenerate.mockResolvedValue(defaultGenerateResult({ messages }))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      const body = await res.json() as Record<string, unknown>
      const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!
      const message = choice['message'] as Record<string, unknown>
      const toolCalls = message['tool_calls'] as Array<Record<string, unknown>>
      expect(toolCalls).toHaveLength(2)
    })

    it('uses correct usage token counts from result', async () => {
      mockGenerate.mockResolvedValue(defaultGenerateResult({
        usage: { totalInputTokens: 100, totalOutputTokens: 50, llmCalls: 2 },
      }))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      })

      const body = await res.json() as Record<string, unknown>
      const usage = body['usage'] as Record<string, unknown>
      expect(usage['prompt_tokens']).toBe(100)
      expect(usage['completion_tokens']).toBe(50)
      expect(usage['total_tokens']).toBe(150)
    })
  })
})
