/**
 * Unit tests for request-mapper.ts
 *
 * Covers all three gap-fix functions:
 * - GAP-1: mapRequest() — system message extraction
 * - GAP-2: mapFinalStreamChunk() — finish_reason='length' for iteration limits
 * - GAP-3: extractToolCallsFromMessages() + mapResponseWithTools()
 */
import { describe, it, expect } from 'vitest'
import type { BaseMessage } from '@langchain/core/messages'
import {
  mapRequest,
  mapFinalStreamChunk,
  extractToolCallsFromMessages,
  mapResponseWithTools,
  validateCompletionRequest,
  generateCompletionId,
  badRequest,
  notFoundError,
  serverError,
} from '../request-mapper.js'

// ---------------------------------------------------------------------------
// GAP-1: mapRequest — system message extraction
// ---------------------------------------------------------------------------

describe('GAP-1: mapRequest — system message extraction', () => {
  it('extracts system message into systemOverride', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [
        { role: 'system', content: 'You are a coder.' },
        { role: 'user', content: 'Hello' },
      ],
    })

    expect(result.systemOverride).toBe('You are a coder.')
  })

  it('excludes system messages from the prompt string', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [
        { role: 'system', content: 'You are a coder.' },
        { role: 'user', content: 'Hello' },
      ],
    })

    expect(result.prompt).not.toContain('System:')
    expect(result.prompt).toBe('User: Hello')
  })

  it('concatenates multiple system messages with newlines', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [
        { role: 'system', content: 'Rule 1' },
        { role: 'system', content: 'Rule 2' },
        { role: 'user', content: 'Go' },
      ],
    })

    expect(result.systemOverride).toBe('Rule 1\nRule 2')
    expect(result.prompt).toBe('User: Go')
  })

  it('sets systemOverride to null when no system messages exist', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(result.systemOverride).toBeNull()
  })

  it('handles system-only message list with no conversation turns', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [{ role: 'system', content: 'Instructions' }],
    })

    expect(result.systemOverride).toBe('Instructions')
    expect(result.prompt).toBe('')
  })

  it('preserves non-system messages in order', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    })

    expect(result.prompt).toBe('User: first\n\nAssistant: reply\n\nUser: second')
  })

  it('extracts agentId from model field', () => {
    const result = mapRequest({
      model: 'my-agent',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.agentId).toBe('my-agent')
  })

  it('passes through temperature, max_tokens, stop', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.8,
      max_tokens: 256,
      stop: ['\n'],
    })

    expect(result.options.temperature).toBe(0.8)
    expect(result.options.maxTokens).toBe(256)
    expect(result.options.stop).toEqual(['\n'])
  })

  it('omits options fields that are not provided', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(result.options).toEqual({})
  })

  it('handles null content in system message', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [
        { role: 'system', content: null },
        { role: 'user', content: 'hello' },
      ],
    })

    expect(result.systemOverride).toBe('')
    expect(result.prompt).toBe('User: hello')
  })

  it('handles tool role messages in prompt', () => {
    const result = mapRequest({
      model: 'agent-1',
      messages: [
        { role: 'user', content: 'use a tool' },
        { role: 'tool', content: 'result data', tool_call_id: 'call_1' },
      ],
    })

    expect(result.prompt).toContain('Tool: result data')
    expect(result.systemOverride).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GAP-2: mapFinalStreamChunk — finish_reason for iteration limits
// ---------------------------------------------------------------------------

describe('GAP-2: mapFinalStreamChunk — finish_reason propagation', () => {
  const model = 'test-model'
  const completionId = 'chatcmpl-test'

  it('emits finish_reason=stop for a normal done event', () => {
    const chunk = mapFinalStreamChunk(model, completionId, { stopReason: 'end_turn' })

    expect(chunk.choices[0]!.finish_reason).toBe('stop')
  })

  it('emits finish_reason=length when hitIterationLimit is true', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {
      hitIterationLimit: true,
      stopReason: 'end_turn',
    })

    expect(chunk.choices[0]!.finish_reason).toBe('length')
  })

  it('emits finish_reason=length when stopReason is iteration_limit', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {
      hitIterationLimit: false,
      stopReason: 'iteration_limit',
    })

    expect(chunk.choices[0]!.finish_reason).toBe('length')
  })

  it('emits finish_reason=length when stopReason is budget_exceeded', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {
      hitIterationLimit: true,
      stopReason: 'budget_exceeded',
    })

    expect(chunk.choices[0]!.finish_reason).toBe('length')
  })

  it('emits finish_reason=stop for empty done event data', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {})

    expect(chunk.choices[0]!.finish_reason).toBe('stop')
  })

  it('returns a valid ChatCompletionChunk shape', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {})

    expect(chunk.id).toBe(completionId)
    expect(chunk.object).toBe('chat.completion.chunk')
    expect(typeof chunk.created).toBe('number')
    expect(chunk.model).toBe(model)
    expect(Array.isArray(chunk.choices)).toBe(true)
    expect(chunk.choices).toHaveLength(1)
  })

  it('sets delta to empty object', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {})

    expect(chunk.choices[0]!.delta).toEqual({})
  })

  it('sets choice index to 0', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {})

    expect(chunk.choices[0]!.index).toBe(0)
  })

  it('created is a Unix timestamp in seconds', () => {
    const before = Math.floor(Date.now() / 1000)
    const chunk = mapFinalStreamChunk(model, completionId, {})
    const after = Math.floor(Date.now() / 1000)

    expect(chunk.created).toBeGreaterThanOrEqual(before)
    expect(chunk.created).toBeLessThanOrEqual(after)
  })

  it('does not emit length for unknown stopReason values', () => {
    const chunk = mapFinalStreamChunk(model, completionId, {
      stopReason: 'max_tokens',
      hitIterationLimit: false,
    })

    expect(chunk.choices[0]!.finish_reason).toBe('stop')
  })
})

// ---------------------------------------------------------------------------
// GAP-3: extractToolCallsFromMessages
// ---------------------------------------------------------------------------

describe('GAP-3: extractToolCallsFromMessages', () => {
  function makeAIMessageWithToolCalls(
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  ): BaseMessage {
    return {
      _getType: () => 'ai',
      content: '',
      tool_calls: toolCalls,
    } as unknown as BaseMessage
  }

  it('returns empty array when no messages have tool_calls', () => {
    const messages: BaseMessage[] = [
      { _getType: () => 'human', content: 'hi' } as unknown as BaseMessage,
    ]

    expect(extractToolCallsFromMessages(messages)).toEqual([])
  })

  it('extracts tool calls from AI messages', () => {
    const messages = [
      makeAIMessageWithToolCalls([
        { id: 'call_1', name: 'search', args: { q: 'hello' } },
      ]),
    ]

    const result = extractToolCallsFromMessages(messages)

    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('call_1')
    expect(result[0]!.type).toBe('function')
    expect(result[0]!.function.name).toBe('search')
    expect(result[0]!.function.arguments).toBe(JSON.stringify({ q: 'hello' }))
  })

  it('extracts multiple tool calls from one message', () => {
    const messages = [
      makeAIMessageWithToolCalls([
        { id: 'call_1', name: 'search', args: { q: 'a' } },
        { id: 'call_2', name: 'fetch', args: { url: 'b' } },
      ]),
    ]

    const result = extractToolCallsFromMessages(messages)

    expect(result).toHaveLength(2)
    expect(result[0]!.function.name).toBe('search')
    expect(result[1]!.function.name).toBe('fetch')
  })

  it('collects tool calls from multiple messages', () => {
    const messages = [
      makeAIMessageWithToolCalls([{ id: 'call_1', name: 'fn1', args: {} }]),
      { _getType: () => 'tool', content: 'result' } as unknown as BaseMessage,
      makeAIMessageWithToolCalls([{ id: 'call_2', name: 'fn2', args: {} }]),
    ]

    const result = extractToolCallsFromMessages(messages)

    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('call_1')
    expect(result[1]!.id).toBe('call_2')
  })

  it('generates an ID when tool call lacks one', () => {
    const messages = [
      {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ name: 'search', args: { q: 'test' } }],
      } as unknown as BaseMessage,
    ]

    const result = extractToolCallsFromMessages(messages)

    expect(result).toHaveLength(1)
    expect(typeof result[0]!.id).toBe('string')
    expect(result[0]!.id.length).toBeGreaterThan(0)
  })

  it('stringifies object args to JSON', () => {
    const args = { key: 'value', num: 42 }
    const messages = [
      makeAIMessageWithToolCalls([{ id: 'c1', name: 'fn', args }]),
    ]

    const result = extractToolCallsFromMessages(messages)

    expect(result[0]!.function.arguments).toBe(JSON.stringify(args))
  })

  it('preserves string args as-is', () => {
    const messages = [
      {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ id: 'c1', name: 'fn', args: '{"raw":true}' }],
      } as unknown as BaseMessage,
    ]

    const result = extractToolCallsFromMessages(messages)

    expect(result[0]!.function.arguments).toBe('{"raw":true}')
  })

  it('uses empty object string for null/undefined args', () => {
    const messages = [
      {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ id: 'c1', name: 'fn', args: null }],
      } as unknown as BaseMessage,
    ]

    const result = extractToolCallsFromMessages(messages)

    expect(result[0]!.function.arguments).toBe('{}')
  })
})

// ---------------------------------------------------------------------------
// GAP-3: mapResponseWithTools
// ---------------------------------------------------------------------------

describe('GAP-3: mapResponseWithTools', () => {
  const baseUsage = { totalInputTokens: 20, totalOutputTokens: 10 }
  const noMessages: BaseMessage[] = []

  it('returns a valid ChatCompletionResponse shape', () => {
    const response = mapResponseWithTools(
      'Hello', 'agent-1', 'chatcmpl-abc', baseUsage, noMessages, false,
    )

    expect(response.id).toBe('chatcmpl-abc')
    expect(response.object).toBe('chat.completion')
    expect(response.model).toBe('agent-1')
    expect(typeof response.created).toBe('number')
    expect(response.choices).toHaveLength(1)
  })

  it('sets usage from provided token counts', () => {
    const response = mapResponseWithTools(
      'content', 'a', 'id', baseUsage, noMessages, false,
    )

    expect(response.usage.prompt_tokens).toBe(20)
    expect(response.usage.completion_tokens).toBe(10)
    expect(response.usage.total_tokens).toBe(30)
  })

  it('sets finish_reason=stop when no tools and no iteration limit', () => {
    const response = mapResponseWithTools(
      'hi', 'a', 'id', baseUsage, noMessages, false,
    )

    expect(response.choices[0]!.finish_reason).toBe('stop')
  })

  it('sets finish_reason=length when hitIterationLimit is true', () => {
    const response = mapResponseWithTools(
      'hi', 'a', 'id', baseUsage, noMessages, true,
    )

    expect(response.choices[0]!.finish_reason).toBe('length')
  })

  it('sets finish_reason=tool_calls when messages contain tool invocations', () => {
    const messages = [
      {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ id: 'c1', name: 'search', args: { q: 'hi' } }],
      } as unknown as BaseMessage,
    ]

    const response = mapResponseWithTools(
      '', 'a', 'id', baseUsage, messages, false,
    )

    expect(response.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('includes tool_calls array in choice message when tools were invoked', () => {
    const messages = [
      {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ id: 'c1', name: 'search', args: { q: 'hi' } }],
      } as unknown as BaseMessage,
    ]

    const response = mapResponseWithTools(
      '', 'a', 'id', baseUsage, messages, false,
    )

    const choice = response.choices[0]!
    expect(choice.message.tool_calls).toBeDefined()
    expect(choice.message.tool_calls).toHaveLength(1)
    expect(choice.message.tool_calls![0]!.function.name).toBe('search')
  })

  it('omits tool_calls from message when no tools were invoked', () => {
    const response = mapResponseWithTools(
      'text', 'a', 'id', baseUsage, noMessages, false,
    )

    expect(response.choices[0]!.message.tool_calls).toBeUndefined()
  })

  it('sets message role to assistant', () => {
    const response = mapResponseWithTools(
      'text', 'a', 'id', baseUsage, noMessages, false,
    )

    expect(response.choices[0]!.message.role).toBe('assistant')
  })

  it('tool_calls takes priority over iteration limit for finish_reason', () => {
    const messages = [
      {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ id: 'c1', name: 'fn', args: {} }],
      } as unknown as BaseMessage,
    ]

    const response = mapResponseWithTools(
      '', 'a', 'id', baseUsage, messages, true,
    )

    // tool_calls takes priority
    expect(response.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('sets content to null when content is empty string', () => {
    const response = mapResponseWithTools(
      '', 'a', 'id', baseUsage, noMessages, false,
    )

    expect(response.choices[0]!.message.content).toBeNull()
  })

  it('preserves non-empty content', () => {
    const response = mapResponseWithTools(
      'Hello world', 'a', 'id', baseUsage, noMessages, false,
    )

    expect(response.choices[0]!.message.content).toBe('Hello world')
  })
})

// ---------------------------------------------------------------------------
// validateCompletionRequest
// ---------------------------------------------------------------------------

describe('validateCompletionRequest', () => {
  it('accepts a valid minimal request', () => {
    const result = validateCompletionRequest({
      model: 'agent-1',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(result.ok).toBe(true)
  })

  it('rejects non-object body', () => {
    const result = validateCompletionRequest('string')
    expect(result.ok).toBe(false)
  })

  it('rejects missing model', () => {
    const result = validateCompletionRequest({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.error.param).toBe('model')
    }
  })

  it('rejects empty messages array', () => {
    const result = validateCompletionRequest({ model: 'a', messages: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.error.param).toBe('messages')
    }
  })

  it('rejects invalid role', () => {
    const result = validateCompletionRequest({
      model: 'a',
      messages: [{ role: 'invalid', content: 'hi' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.error.param).toBe('messages[0].role')
    }
  })

  it('accepts system role', () => {
    const result = validateCompletionRequest({
      model: 'a',
      messages: [{ role: 'system', content: 'instructions' }],
    })
    expect(result.ok).toBe(true)
  })

  it('accepts assistant role', () => {
    const result = validateCompletionRequest({
      model: 'a',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    })
    expect(result.ok).toBe(true)
  })

  it('accepts tool role', () => {
    const result = validateCompletionRequest({
      model: 'a',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'result', tool_call_id: 'c1' },
      ],
    })
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

describe('Error helpers', () => {
  it('badRequest returns invalid_request_error type', () => {
    const err = badRequest('bad')
    expect(err.error.type).toBe('invalid_request_error')
    expect(err.error.message).toBe('bad')
  })

  it('notFoundError includes model name in message', () => {
    const err = notFoundError('my-agent')
    expect(err.error.message).toContain('my-agent')
    expect(err.error.code).toBe('model_not_found')
  })

  it('serverError returns server_error type', () => {
    const err = serverError('oops')
    expect(err.error.type).toBe('server_error')
    expect(err.error.code).toBe('internal_error')
  })
})

// ---------------------------------------------------------------------------
// generateCompletionId
// ---------------------------------------------------------------------------

describe('generateCompletionId', () => {
  it('returns a chatcmpl- prefixed string', () => {
    expect(generateCompletionId()).toMatch(/^chatcmpl-/)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, generateCompletionId))
    expect(ids.size).toBe(100)
  })
})
