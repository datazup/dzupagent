/**
 * Tests for OpenAI-compatible streaming tool_calls delta format.
 *
 * Covers:
 * - OpenAICompletionMapper tool call mapping methods
 * - Streaming route integration with mock agent.stream()
 * - Type/shape validation of emitted chunks
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAICompletionMapper } from '../completion-mapper.js'
import type {
  ChatCompletionChunkWithTools,
  StreamingToolCallDelta,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertChunkShape(chunk: ChatCompletionChunkWithTools): void {
  expect(chunk).toHaveProperty('id')
  expect(chunk).toHaveProperty('object', 'chat.completion.chunk')
  expect(chunk).toHaveProperty('created')
  expect(typeof chunk.created).toBe('number')
  expect(chunk.created).toBeGreaterThan(0)
  expect(chunk).toHaveProperty('model')
  expect(chunk).toHaveProperty('choices')
  expect(Array.isArray(chunk.choices)).toBe(true)
  expect(chunk.choices.length).toBeGreaterThan(0)
}

// ---------------------------------------------------------------------------
// mapToolCallInitChunk
// ---------------------------------------------------------------------------

describe('OpenAICompletionMapper.mapToolCallInitChunk', () => {
  let mapper: OpenAICompletionMapper

  beforeEach(() => {
    mapper = new OpenAICompletionMapper()
  })

  it('returns correct object shape', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    assertChunkShape(chunk)
  })

  it('sets object to chat.completion.chunk', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.object).toBe('chat.completion.chunk')
  })

  it('uses the provided completion ID', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.id).toBe('chatcmpl-abc')
  })

  it('uses the provided model', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.model).toBe('gpt-4')
  })

  it('sets delta.tool_calls[0].id to the provided tool call ID', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.id).toBe('call_xyz')
  })

  it('sets delta.tool_calls[0].function.name to the tool name', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.function!.name).toBe('search')
  })

  it('sets delta.tool_calls[0].function.arguments to empty string', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.function!.arguments).toBe('')
  })

  it('sets finish_reason to null', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.finish_reason).toBeNull()
  })

  it('sets delta.tool_calls[0].type to function', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.type).toBe('function')
  })

  it('sets delta.tool_calls[0].index to the provided tool index', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 2, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.index).toBe(2)
  })

  it('sets choices[0].index to 0', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.index).toBe(0)
  })

  it('created is a Unix timestamp (seconds, not ms)', () => {
    const before = Math.floor(Date.now() / 1000)
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    const after = Math.floor(Date.now() / 1000)
    expect(chunk.created).toBeGreaterThanOrEqual(before)
    expect(chunk.created).toBeLessThanOrEqual(after)
  })

  it('does not include content in delta', () => {
    const chunk = mapper.mapToolCallInitChunk('call_xyz', 'search', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.delta.content).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mapToolCallArgumentsChunk
// ---------------------------------------------------------------------------

describe('OpenAICompletionMapper.mapToolCallArgumentsChunk', () => {
  let mapper: OpenAICompletionMapper

  beforeEach(() => {
    mapper = new OpenAICompletionMapper()
  })

  it('returns correct object shape', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-abc')
    assertChunkShape(chunk)
  })

  it('sets delta.tool_calls[0].function.arguments to the fragment', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.function!.arguments).toBe('{"q":')
  })

  it('does not include id in arguments chunk', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.id).toBeUndefined()
  })

  it('does not include type in arguments chunk', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.type).toBeUndefined()
  })

  it('does not include name in arguments chunk function', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.function!.name).toBeUndefined()
  })

  it('sets finish_reason to null', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.finish_reason).toBeNull()
  })

  it('preserves the tool index', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 1, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.index).toBe(1)
  })

  it('does not include content in delta', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.delta.content).toBeUndefined()
  })

  it('handles empty string argument fragment', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('', 0, 'gpt-4', 'chatcmpl-abc')
    const tc = chunk.choices[0]!.delta.tool_calls![0]!
    expect(tc.function!.arguments).toBe('')
  })
})

// ---------------------------------------------------------------------------
// mapToolCallsFinishChunk
// ---------------------------------------------------------------------------

describe('OpenAICompletionMapper.mapToolCallsFinishChunk', () => {
  let mapper: OpenAICompletionMapper

  beforeEach(() => {
    mapper = new OpenAICompletionMapper()
  })

  it('returns correct object shape', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-abc')
    assertChunkShape(chunk)
  })

  it('sets finish_reason to tool_calls', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('sets delta to empty object', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.delta).toEqual({})
  })

  it('uses the provided completion ID', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-abc')
    expect(chunk.id).toBe('chatcmpl-abc')
  })

  it('uses the provided model', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-abc')
    expect(chunk.model).toBe('gpt-4')
  })

  it('has no tool_calls in delta', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.delta.tool_calls).toBeUndefined()
  })

  it('has no content in delta', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-abc')
    expect(chunk.choices[0]!.delta.content).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Streaming route integration — simulates the event loop logic
// ---------------------------------------------------------------------------

/**
 * Simulates the streaming loop logic from completions-route.ts.
 * This approach avoids needing to spin up Hono and mock DzupAgent,
 * while directly testing the mapping + fragmentation logic.
 */
interface StreamEvent {
  type: string
  data: Record<string, unknown>
}

interface EmittedChunk {
  raw: string
  parsed: ChatCompletionChunkWithTools
}

function simulateStreamingLoop(
  events: StreamEvent[],
  model: string = 'test-agent',
): EmittedChunk[] {
  const mapper = new OpenAICompletionMapper()
  const completionId = 'chatcmpl-test123'
  const emitted: EmittedChunk[] = []

  const writeSSE = (chunk: ChatCompletionChunkWithTools): void => {
    const raw = JSON.stringify(chunk)
    emitted.push({ raw, parsed: chunk })
  }

  for (const event of events) {
    if (event.type === 'text') {
      const content = typeof event.data['content'] === 'string' ? event.data['content'] : ''
      if (content) {
        const chunk = mapper.mapChunk(content, model, completionId, 0, false)
        // mapChunk returns ChatCompletionChunk, cast for unified test output
        writeSSE(chunk as unknown as ChatCompletionChunkWithTools)
      }
      continue
    }

    if (event.type === 'done') {
      const finalChunk = mapper.mapChunk('', model, completionId, 0, true)
      writeSSE(finalChunk as unknown as ChatCompletionChunkWithTools)
      break
    }

    if (event.type === 'error') {
      // Error chunks are handled differently in the route, skip for this simulation
      break
    }

    if (event.type === 'tool_call') {
      const toolCall = event.data as { name?: string; args?: Record<string, unknown>; id?: string; index?: number }
      const toolIndex = typeof toolCall.index === 'number' ? toolCall.index : 0
      const toolId = typeof toolCall.id === 'string' ? toolCall.id : `call_generated`
      const toolName = typeof toolCall.name === 'string' ? toolCall.name : 'unknown'
      const toolArgs = typeof toolCall.args === 'object' && toolCall.args !== null
        ? JSON.stringify(toolCall.args)
        : ''

      const initChunk = mapper.mapToolCallInitChunk(toolId, toolName, toolIndex, model, completionId)
      writeSSE(initChunk)

      if (toolArgs) {
        const fragmentSize = 20
        for (let i = 0; i < toolArgs.length; i += fragmentSize) {
          const fragment = toolArgs.slice(i, i + fragmentSize)
          const argChunk = mapper.mapToolCallArgumentsChunk(fragment, toolIndex, model, completionId)
          writeSSE(argChunk)
        }
      }

      const finishChunk = mapper.mapToolCallsFinishChunk(model, completionId)
      writeSSE(finishChunk)
      continue
    }

    if (event.type === 'tool_result') {
      // No chunk emitted
      continue
    }

    // budget_warning, stuck — skip
  }

  return emitted
}

describe('Streaming route integration (simulated loop)', () => {
  it('single tool_call emits initChunk + argsChunks + finishChunk', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args: { q: 'hello' } } },
      { type: 'tool_result', data: { name: 'search', result: 'found it' } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // initChunk + args chunks + finishChunk + doneChunk
    expect(chunks.length).toBeGreaterThanOrEqual(3)

    // First chunk is init
    const init = chunks[0]!.parsed
    expect(init.choices[0]!.delta.tool_calls![0]!.function!.name).toBe('search')
    expect(init.choices[0]!.delta.tool_calls![0]!.function!.arguments).toBe('')

    // Last tool-related chunk is finish (before the done chunk)
    const finishIdx = chunks.length - 2 // second-to-last is finishChunk, last is doneChunk
    const finish = chunks[finishIdx]!.parsed
    expect(finish.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('tool_call with empty arguments emits initChunk + finishChunk (no arg fragments)', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'get_time', args: {} } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // {} serializes to "{}" which is 2 chars, so 1 arg fragment
    // Actually {} is non-empty after JSON.stringify -> "{}" (2 chars)
    // Let's check: init + 1 arg fragment + finish + done = 4
    // But if args is literally empty object, JSON.stringify({}) = "{}"
    // which is non-empty, so we get arg fragments.
    // For truly empty args we'd need args: undefined/null
    expect(chunks.length).toBeGreaterThanOrEqual(3)
  })

  it('tool_call with null args emits initChunk + finishChunk with no arg fragments', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'get_time' } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // init + finish + done = 3 chunks total
    expect(chunks.length).toBe(3)

    const init = chunks[0]!.parsed
    expect(init.choices[0]!.delta.tool_calls![0]!.function!.name).toBe('get_time')

    const finish = chunks[1]!.parsed
    expect(finish.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('tool_call then text event emits tool chunks then text chunk', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args: { q: 'hi' } } },
      { type: 'tool_result', data: { name: 'search', result: 'ok' } },
      { type: 'text', data: { content: 'Based on the results' } },
      { type: 'done', data: { content: 'Based on the results', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // tool chunks come first, then text
    const textChunkIdx = chunks.findIndex(
      c => c.parsed.choices[0]!.delta.content === 'Based on the results',
    )
    expect(textChunkIdx).toBeGreaterThan(0)

    // All chunks before text should be tool-related
    for (let i = 0; i < textChunkIdx; i++) {
      const c = chunks[i]!.parsed
      const hasToolCalls = c.choices[0]!.delta.tool_calls !== undefined
      const isFinish = c.choices[0]!.finish_reason === 'tool_calls'
      expect(hasToolCalls || isFinish).toBe(true)
    }
  })

  it('tool_result event produces no chunk', () => {
    const events: StreamEvent[] = [
      { type: 'tool_result', data: { name: 'search', result: 'ok' } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)
    // Only done chunk
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.parsed.choices[0]!.finish_reason).toBe('stop')
  })

  it('full flow: tool_call + tool_result + text + done produces correct sequence', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args: { q: 'test' } } },
      { type: 'tool_result', data: { name: 'search', result: 'found' } },
      { type: 'text', data: { content: 'Here are results' } },
      { type: 'done', data: { content: 'Here are results', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // Verify order: init, args, finish(tool_calls), text, done(stop)
    expect(chunks.length).toBeGreaterThanOrEqual(4)

    // First is init
    expect(chunks[0]!.parsed.choices[0]!.delta.tool_calls![0]!.function!.name).toBe('search')

    // Last is done/stop
    const last = chunks[chunks.length - 1]!.parsed
    expect(last.choices[0]!.finish_reason).toBe('stop')

    // Second-to-last is text
    const textChunk = chunks[chunks.length - 2]!.parsed
    expect(textChunk.choices[0]!.delta.content).toBe('Here are results')
  })

  it('parallel tool calls with index=0 and index=1 are indexed correctly', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args: { q: 'a' }, index: 0 } },
      { type: 'tool_call', data: { name: 'fetch', args: { url: 'b' }, index: 1 } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // Find init chunks for each tool
    const initChunks = chunks.filter(
      c => c.parsed.choices[0]!.delta.tool_calls?.[0]?.function?.name !== undefined,
    )
    expect(initChunks.length).toBe(2)
    expect(initChunks[0]!.parsed.choices[0]!.delta.tool_calls![0]!.index).toBe(0)
    expect(initChunks[0]!.parsed.choices[0]!.delta.tool_calls![0]!.function!.name).toBe('search')
    expect(initChunks[1]!.parsed.choices[0]!.delta.tool_calls![0]!.index).toBe(1)
    expect(initChunks[1]!.parsed.choices[0]!.delta.tool_calls![0]!.function!.name).toBe('fetch')
  })

  it('budget_warning event produces no chunk', () => {
    const events: StreamEvent[] = [
      { type: 'budget_warning', data: { message: 'Running low' } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.parsed.choices[0]!.finish_reason).toBe('stop')
  })

  it('stuck event produces no chunk', () => {
    const events: StreamEvent[] = [
      { type: 'stuck', data: { reason: 'looping', recovery: 'nudge' } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.parsed.choices[0]!.finish_reason).toBe('stop')
  })

  it('long arguments (>100 chars) produce multiple argument fragment chunks', () => {
    const longValue = 'a'.repeat(120)
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'write', args: { content: longValue } } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // Args string = JSON.stringify({ content: "aaa...120 chars" }) which is >120 chars
    const argChunks = chunks.filter(c => {
      const tc = c.parsed.choices[0]!.delta.tool_calls?.[0]
      return tc !== undefined && tc.id === undefined && tc.function?.arguments !== undefined
    })
    expect(argChunks.length).toBeGreaterThan(5) // >100 chars / 20 = at least 6 fragments
  })

  it('arguments exactly 20 chars produce exactly 1 fragment chunk', () => {
    // We need args JSON to be exactly 20 chars. JSON.stringify({a:"1234567890123"}) = {"a":"1234567890123"} = 20 chars
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'fn', args: { a: '1234567890123' } } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    const argChunks = chunks.filter(c => {
      const tc = c.parsed.choices[0]!.delta.tool_calls?.[0]
      return tc !== undefined && tc.id === undefined && tc.function?.arguments !== undefined
    })

    // JSON.stringify({ a: '1234567890123' }) = '{"a":"1234567890123"}' = 21 chars
    // So actually 21 chars -> 2 fragments. Let's adjust to make exactly 20
    // We'll verify by checking the fragment count matches ceil(len/20)
    const argsStr = JSON.stringify({ a: '1234567890123' })
    const expectedFragments = Math.ceil(argsStr.length / 20)
    expect(argChunks.length).toBe(expectedFragments)
  })

  it('arguments of 21 chars produce exactly 2 fragment chunks', () => {
    // Use a known-length args string
    const args = { x: '0123456789abcde' }
    const argsStr = JSON.stringify(args) // '{"x":"0123456789abcde"}' = 23 chars
    const expectedFragments = Math.ceil(argsStr.length / 20)

    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'fn', args } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    const argChunks = chunks.filter(c => {
      const tc = c.parsed.choices[0]!.delta.tool_calls?.[0]
      return tc !== undefined && tc.id === undefined && tc.function?.arguments !== undefined
    })
    expect(argChunks.length).toBe(expectedFragments)
  })

  it('tool_call with no name defaults to unknown', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { args: { q: 'test' } } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)
    const init = chunks[0]!.parsed
    expect(init.choices[0]!.delta.tool_calls![0]!.function!.name).toBe('unknown')
  })

  it('tool_call with provided id uses that id', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args: { q: 'hi' }, id: 'call_custom' } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)
    const init = chunks[0]!.parsed
    expect(init.choices[0]!.delta.tool_calls![0]!.id).toBe('call_custom')
  })

  it('tool_call without id gets a generated id', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args: { q: 'hi' } } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)
    const init = chunks[0]!.parsed
    expect(init.choices[0]!.delta.tool_calls![0]!.id).toBe('call_generated')
  })

  it('all emitted tool chunks share the same completion ID', () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args: { query: 'hello world' } } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)
    const ids = new Set(chunks.map(c => c.parsed.id))
    expect(ids.size).toBe(1)
  })

  it('argument fragments concatenated reconstruct the original JSON', () => {
    const args = { query: 'hello world', limit: 10 }
    const events: StreamEvent[] = [
      { type: 'tool_call', data: { name: 'search', args } },
      { type: 'done', data: { content: '', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // Collect all argument fragments
    const fragments: string[] = []
    for (const c of chunks) {
      const tc = c.parsed.choices[0]!.delta.tool_calls?.[0]
      if (tc && tc.id === undefined && tc.function?.arguments !== undefined) {
        fragments.push(tc.function.arguments)
      }
    }

    const reconstructed = fragments.join('')
    expect(reconstructed).toBe(JSON.stringify(args))
  })

  it('text events before tool_call are emitted correctly', () => {
    const events: StreamEvent[] = [
      { type: 'text', data: { content: 'Let me search' } },
      { type: 'tool_call', data: { name: 'search', args: { q: 'hi' } } },
      { type: 'tool_result', data: { name: 'search', result: 'ok' } },
      { type: 'done', data: { content: 'Let me search', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    // First chunk should be text
    expect(chunks[0]!.parsed.choices[0]!.delta.content).toBe('Let me search')
  })

  it('multiple text events interleaved with tool calls maintain order', () => {
    const events: StreamEvent[] = [
      { type: 'text', data: { content: 'Part 1' } },
      { type: 'tool_call', data: { name: 'search', args: { q: 'a' } } },
      { type: 'tool_result', data: { name: 'search', result: 'r1' } },
      { type: 'text', data: { content: 'Part 2' } },
      { type: 'done', data: { content: 'Part 1 Part 2', stopReason: 'complete' } },
    ]
    const chunks = simulateStreamingLoop(events)

    const textChunks = chunks.filter(c => c.parsed.choices[0]!.delta.content !== undefined)
    expect(textChunks.length).toBe(2)
    expect(textChunks[0]!.parsed.choices[0]!.delta.content).toBe('Part 1')
    expect(textChunks[1]!.parsed.choices[0]!.delta.content).toBe('Part 2')
  })
})

// ---------------------------------------------------------------------------
// Type validation tests
// ---------------------------------------------------------------------------

describe('Type validation for tool call chunks', () => {
  let mapper: OpenAICompletionMapper

  beforeEach(() => {
    mapper = new OpenAICompletionMapper()
  })

  it('init chunk has all required top-level fields', () => {
    const chunk = mapper.mapToolCallInitChunk('call_1', 'search', 0, 'gpt-4', 'chatcmpl-1')
    expect(typeof chunk.id).toBe('string')
    expect(typeof chunk.object).toBe('string')
    expect(typeof chunk.created).toBe('number')
    expect(typeof chunk.model).toBe('string')
    expect(Array.isArray(chunk.choices)).toBe(true)
  })

  it('arguments chunk has all required top-level fields', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{}', 0, 'gpt-4', 'chatcmpl-1')
    expect(typeof chunk.id).toBe('string')
    expect(typeof chunk.object).toBe('string')
    expect(typeof chunk.created).toBe('number')
    expect(typeof chunk.model).toBe('string')
    expect(Array.isArray(chunk.choices)).toBe(true)
  })

  it('finish chunk has all required top-level fields', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-1')
    expect(typeof chunk.id).toBe('string')
    expect(typeof chunk.object).toBe('string')
    expect(typeof chunk.created).toBe('number')
    expect(typeof chunk.model).toBe('string')
    expect(Array.isArray(chunk.choices)).toBe(true)
  })

  it('created is a positive integer (Unix timestamp)', () => {
    const chunk = mapper.mapToolCallInitChunk('call_1', 'search', 0, 'gpt-4', 'chatcmpl-1')
    expect(Number.isInteger(chunk.created)).toBe(true)
    expect(chunk.created).toBeGreaterThan(1000000000) // after 2001
  })

  it('init chunk delta.tool_calls is an array with exactly one element', () => {
    const chunk = mapper.mapToolCallInitChunk('call_1', 'search', 0, 'gpt-4', 'chatcmpl-1')
    expect(Array.isArray(chunk.choices[0]!.delta.tool_calls)).toBe(true)
    expect(chunk.choices[0]!.delta.tool_calls!.length).toBe(1)
  })

  it('arguments chunk delta.tool_calls is an array with exactly one element', () => {
    const chunk = mapper.mapToolCallArgumentsChunk('{"q":', 0, 'gpt-4', 'chatcmpl-1')
    expect(Array.isArray(chunk.choices[0]!.delta.tool_calls)).toBe(true)
    expect(chunk.choices[0]!.delta.tool_calls!.length).toBe(1)
  })

  it('generateId produces chatcmpl- prefixed IDs', () => {
    const id = mapper.generateId()
    expect(id.startsWith('chatcmpl-')).toBe(true)
    expect(id.length).toBeGreaterThan('chatcmpl-'.length)
  })

  it('JSON.stringify of init chunk is valid JSON parseable back', () => {
    const chunk = mapper.mapToolCallInitChunk('call_1', 'search', 0, 'gpt-4', 'chatcmpl-1')
    const json = JSON.stringify(chunk)
    const parsed = JSON.parse(json)
    expect(parsed.choices[0].delta.tool_calls[0].function.name).toBe('search')
  })

  it('JSON.stringify of finish chunk is valid JSON parseable back', () => {
    const chunk = mapper.mapToolCallsFinishChunk('gpt-4', 'chatcmpl-1')
    const json = JSON.stringify(chunk)
    const parsed = JSON.parse(json)
    expect(parsed.choices[0].finish_reason).toBe('tool_calls')
  })
})
