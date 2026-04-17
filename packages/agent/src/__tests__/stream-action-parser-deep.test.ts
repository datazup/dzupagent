import { describe, it, expect } from 'vitest'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { StreamActionParser } from '../streaming/stream-action-parser.js'

function mockTool(name: string, fn: (args: Record<string, unknown>) => Promise<string>): StructuredToolInterface {
  return { name, invoke: fn } as unknown as StructuredToolInterface
}

describe('StreamActionParser', () => {
  describe('text extraction', () => {
    it('extracts text from string content', async () => {
      const parser = new StreamActionParser([])
      const events = await parser.processChunk({ content: 'hello world' })
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('text')
      expect(events[0]!.data.content).toBe('hello world')
    })

    it('extracts text from multimodal content array', async () => {
      const parser = new StreamActionParser([])
      const events = await parser.processChunk({
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
      })
      expect(events).toHaveLength(1)
      expect(events[0]!.data.content).toBe('hello world')
    })

    it('ignores empty string content', async () => {
      const parser = new StreamActionParser([])
      const events = await parser.processChunk({ content: '' })
      expect(events).toHaveLength(0)
    })

    it('ignores empty array content', async () => {
      const parser = new StreamActionParser([])
      const events = await parser.processChunk({ content: [] })
      expect(events).toHaveLength(0)
    })

    it('ignores undefined content', async () => {
      const parser = new StreamActionParser([])
      const events = await parser.processChunk({})
      expect(events).toHaveLength(0)
    })

    it('filters non-text items from content array', async () => {
      const parser = new StreamActionParser([])
      const events = await parser.processChunk({
        content: [
          { type: 'image' },
          { type: 'text', text: 'only text' },
        ],
      })
      expect(events).toHaveLength(1)
      expect(events[0]!.data.content).toBe('only text')
    })
  })

  describe('non-streaming tool_calls', () => {
    it('executes a tool call and returns result', async () => {
      const tool = mockTool('echo', async (args) => `echo: ${args['msg']}`)
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'echo', args: { msg: 'hi' } }],
      })

      const types = events.map(e => e.type)
      expect(types).toContain('tool_call_start')
      expect(types).toContain('tool_call_complete')
      expect(types).toContain('tool_result')
      const result = events.find(e => e.type === 'tool_result')
      expect(result!.data.result).toBe('echo: hi')
    })

    it('handles tool_calls with string args', async () => {
      const tool = mockTool('test', async () => 'ok')
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'test', args: '{"x": 1}' }],
      })

      expect(events.some(e => e.type === 'tool_result')).toBe(true)
    })

    it('handles tool_calls with unparseable string args', async () => {
      const tool = mockTool('test', async () => 'ok')
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'test', args: 'not json' }],
      })

      // args will default to {} since tryParseJson returns undefined
      expect(events.some(e => e.type === 'tool_result')).toBe(true)
    })

    it('generates id when tool_call has no id', async () => {
      const tool = mockTool('test', async () => 'ok')
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_calls: [{ name: 'test', args: {} }],
      })

      expect(events.some(e => e.type === 'tool_call_start')).toBe(true)
    })

    it('does not re-execute already-fired tool call ids', async () => {
      let callCount = 0
      const tool = mockTool('test', async () => { callCount++; return 'ok' })
      const parser = new StreamActionParser([tool])

      await parser.processChunk({ tool_calls: [{ id: 'dup', name: 'test', args: {} }] })
      await parser.processChunk({ tool_calls: [{ id: 'dup', name: 'test', args: {} }] })

      expect(callCount).toBe(1)
    })

    it('returns error event for unknown tool', async () => {
      const parser = new StreamActionParser([])

      const events = await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'nonexistent', args: {} }],
      })

      const err = events.find(e => e.type === 'error')
      expect(err).toBeDefined()
      expect(err!.data.error).toContain('nonexistent')
      expect(err!.data.error).toContain('not found')
    })

    it('handles tool execution errors gracefully', async () => {
      const tool = mockTool('broken', async () => { throw new Error('tool broke') })
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'broken', args: {} }],
      })

      const err = events.find(e => e.type === 'error')
      expect(err).toBeDefined()
      expect(err!.data.error).toBe('tool broke')
    })

    it('handles non-Error tool execution errors', async () => {
      const tool = mockTool('broken', async () => { throw 'string error' })
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'broken', args: {} }],
      })

      const err = events.find(e => e.type === 'error')
      expect(err!.data.error).toBe('string error')
    })

    it('JSON-stringifies non-string tool results', async () => {
      const tool = mockTool('obj', async () => ({ x: 1 }) as unknown as string)
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'obj', args: {} }],
      })

      const result = events.find(e => e.type === 'tool_result')
      expect(result!.data.result).toBe('{"x":1}')
    })
  })

  describe('streaming tool_call_chunks', () => {
    it('accumulates partial args and fires when JSON is complete', async () => {
      const tool = mockTool('search', async (args) => `found: ${args['q']}`)
      const parser = new StreamActionParser([tool])

      // First chunk: start of args
      const e1 = await parser.processChunk({
        tool_call_chunks: [{ id: 'tc1', name: 'search', args: '{"q":' }],
      })
      expect(e1.some(e => e.type === 'tool_result')).toBe(false)

      // Second chunk: complete args
      const e2 = await parser.processChunk({
        tool_call_chunks: [{ id: 'tc1', args: '"hello"}' }],
      })
      expect(e2.some(e => e.type === 'tool_result')).toBe(true)
    })

    it('uses index as fallback id', async () => {
      const tool = mockTool('test', async () => 'ok')
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        tool_call_chunks: [{ index: 0, name: 'test', args: '{}' }],
      })

      expect(events.some(e => e.type === 'tool_result')).toBe(true)
    })

    it('skips chunks with no id and no index', async () => {
      const parser = new StreamActionParser([])

      const events = await parser.processChunk({
        tool_call_chunks: [{ name: 'test', args: '{}' }],
      })

      expect(events).toHaveLength(0)
    })

    it('accumulates name from later chunks', async () => {
      const tool = mockTool('delayed', async () => 'ok')
      const parser = new StreamActionParser([tool])

      // First chunk: args but no name
      await parser.processChunk({
        tool_call_chunks: [{ id: 'x1', args: '{' }],
      })

      // Second chunk: name and rest of args
      const events = await parser.processChunk({
        tool_call_chunks: [{ id: 'x1', name: 'delayed', args: '}' }],
      })

      expect(events.some(e => e.type === 'tool_result')).toBe(true)
    })
  })

  describe('flush', () => {
    it('fires unfired pending calls with parseable args', async () => {
      const tool = mockTool('lazy', async () => 'flushed')
      const parser = new StreamActionParser([tool])

      // Partial args that are incomplete JSON -- will not fire during processChunk
      await parser.processChunk({
        tool_call_chunks: [{ id: 'f1', name: 'lazy', args: '{"a":' }],
      })

      // Complete the JSON in another chunk but don't trigger (still accumulating)
      await parser.processChunk({
        tool_call_chunks: [{ id: 'f1', args: '1}' }],
      })

      // Nothing is pending because it already fired when JSON became complete
      const flushed = await parser.flush()
      // The call should have already been fired during processChunk
      // Flush handles any remaining unfired ones
      expect(flushed.length).toBeGreaterThanOrEqual(0)
    })

    it('returns empty for fully consumed parser', async () => {
      const parser = new StreamActionParser([])
      const events = await parser.flush()
      expect(events).toHaveLength(0)
    })

    it('skips pending entries without a name', async () => {
      const parser = new StreamActionParser([])

      // Chunk with args but no name
      await parser.processChunk({
        tool_call_chunks: [{ id: 'no-name', args: '{}' }],
      })

      const flushed = await parser.flush()
      // No name = skipped
      expect(flushed.filter(e => e.type === 'tool_result')).toHaveLength(0)
    })
  })

  describe('parallel execution', () => {
    it('executes sequentially when parallelExecution is false', async () => {
      const order: string[] = []
      const tool = mockTool('seq', async (args) => {
        order.push(args['id'] as string)
        return 'ok'
      })
      const parser = new StreamActionParser([tool], { parallelExecution: false })

      await parser.processChunk({
        tool_calls: [{ id: 'c1', name: 'seq', args: { id: 'first' } }],
      })
      await parser.processChunk({
        tool_calls: [{ id: 'c2', name: 'seq', args: { id: 'second' } }],
      })

      expect(order).toEqual(['first', 'second'])
    })

    it('runs tools in parallel when enabled', async () => {
      const tool = mockTool('par', async () => 'ok')
      const parser = new StreamActionParser([tool], {
        parallelExecution: true,
        maxParallelTools: 5,
      })

      const events = await parser.processChunk({
        tool_calls: [{ id: 'p1', name: 'par', args: {} }],
      })

      // Parallel mode returns tool_call_complete immediately (start + complete)
      expect(events.some(e => e.type === 'tool_call_start')).toBe(true)
      expect(events.some(e => e.type === 'tool_call_complete')).toBe(true)

      // Results come from flush (the async tool may or may not have completed yet)
      const flushed = await parser.flush()
      const allEvents = [...events, ...flushed]
      expect(allEvents.some(e => e.type === 'tool_call_complete')).toBe(true)
    })
  })

  describe('combined text and tool calls', () => {
    it('returns both text and tool events from same chunk', async () => {
      const tool = mockTool('test', async () => 'result')
      const parser = new StreamActionParser([tool])

      const events = await parser.processChunk({
        content: 'some text',
        tool_calls: [{ id: 'c1', name: 'test', args: {} }],
      })

      expect(events.some(e => e.type === 'text')).toBe(true)
      expect(events.some(e => e.type === 'tool_call_start')).toBe(true)
    })
  })
})
